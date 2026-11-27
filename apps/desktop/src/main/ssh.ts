import ssh2 from "ssh2";
import type { Client, ClientChannel } from "ssh2";
const { Client: SSHClient } = ssh2;
import { readFile, mkdir, writeFile, chmod, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VPS, RemoteState } from "@gungun/domain";
import type { Store } from "./store";
const exec = promisify(execFile);
const DEFAULT_SSH_KEY_PATH = "~/.ssh/id_ed25519_gungun";
export function resolveSSHKeyPath(path: string) {
  return path.replace(/^~(?=\/)/, homedir());
}
export const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export interface Connection {
  client: Client;
  close: () => void;
}
export class SSH {
  constructor(private store: Store) {}
  async connect(vps: VPS, seen = new Set<string>()): Promise<Connection> {
    if (seen.has(vps.id)) throw new Error("跳板机循环");
    seen.add(vps.id);
    let parent: Connection | undefined;
    let sock: ClientChannel | undefined;
    if (vps.jumpId) {
      parent = await this.connect(this.store.get<VPS>("vps", vps.jumpId), seen);
      try {
        sock = await new Promise((resolve, reject) =>
          parent!.client.forwardOut(
            "127.0.0.1",
            0,
            vps.address,
            vps.sshPort,
            (e, s) => (e ? reject(e) : resolve(s)),
          ),
        );
      } catch (e) {
        parent.close();
        throw new Error(`跳板机已连接，目标转发失败：${String(e)}`);
      }
    }
    const client = new SSHClient();
    let verifyError = "";
    try {
      const privateKey =
        vps.auth === "key"
          ? await readFile(
              resolveSSHKeyPath(
                vps.keyPath || this.store.settings().sshKeyPath || DEFAULT_SSH_KEY_PATH,
              ),
            )
          : undefined;
      await new Promise<void>((resolve, reject) => {
        client
          .once("ready", resolve)
          .once("error", (e) => reject(new Error(verifyError || e.message)))
          .connect({
            host: vps.address,
            port: vps.sshPort,
            username: vps.username,
            password: vps.auth === "password" ? vps.password : undefined,
            privateKey,
            sock,
            readyTimeout: 15000,
            keepaliveInterval: 15000,
            keepaliveCountMax: 3,
            hostVerifier: (key: Buffer) => {
              const fp = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
              const address = `${vps.address}:${vps.sshPort}`;
              const trusted = this.store.fingerprint(address);
              if (trusted === fp) return true;
              verifyError = JSON.stringify({
                code: trusted ? "HOST_KEY_CHANGED" : "HOST_KEY_UNKNOWN",
                address,
                fingerprint: fp,
                message: trusted
                  ? "主机指纹已变更，请独立核验后更新信任"
                  : "首次连接，请核验并信任主机指纹",
              });
              return false;
            },
          });
      });
      return {
        client,
        close: () => {
          client.end();
          parent?.close();
        },
      };
    } catch (e) {
      client.destroy();
      parent?.close();
      throw e;
    }
  }
  async run(
    vps: VPS,
    command: string,
    input = "",
    timeoutMs = 120000,
    maxBytes = 16 * 1024 * 1024,
  ) {
    const c = await this.connect(vps);
    try {
      return await new Promise<string>((resolve, reject) => {
        let output = "",
          err = "",
          size = 0;
        const timer = setTimeout(() => {
          c.close();
          reject(new Error("SSH 命令超时"));
        }, timeoutMs);
        c.client.exec(command, (error, stream) => {
          if (error) {
            clearTimeout(timer);
            reject(error);
            return;
          }
          stream.on("data", (b: Buffer) => {
            size += b.length;
            if (size > maxBytes) {
              stream.close();
              clearTimeout(timer);
              reject(new Error("远程输出过大"));
              return;
            }
            output += b.toString();
          });
          stream.stderr.on("data", (b: Buffer) => {
            err = (err + b.toString()).slice(-16000);
          });
          stream.on("close", (code: number) => {
            clearTimeout(timer);
            if (code !== 0)
              reject(new Error(`远程命令失败 (${code})：${err || output}`));
            else resolve(output);
          });
          stream.on("error", (e: Error) => {
            clearTimeout(timer);
            reject(e);
          });
          stream.end(input);
        });
      });
    } finally {
      c.close();
    }
  }
  async fq<T>(vps: VPS, action: string, input?: unknown): Promise<T> {
    if (!/^[a-z][a-z -]*$/.test(action)) throw new Error("无效 fq 操作");
    const command = `${vps.username === "root" ? "" : "sudo -n "}/usr/local/bin/fq ${action} --json`;
    const output = await this.run(
      vps,
      command,
      input === undefined ? "" : JSON.stringify(input),
      300000,
    );
    return JSON.parse(output) as T;
  }
  async upload(vps: VPS, local: string, remote: string) {
    const c = await this.connect(vps);
    try {
      await new Promise<void>((resolve, reject) =>
        c.client.sftp((e, s) => {
          if (e) {
            reject(e);
            return;
          }
          s.fastPut(local, remote, { mode: 0o700 }, (err) => {
            s.end();
            if (err) reject(err);
            else resolve();
          });
        }),
      );
    } finally {
      c.close();
    }
  }
  async state(vps: VPS) {
    return this.fq<RemoteState>(vps, "config");
  }
  async test(vps: VPS) {
    const start = performance.now();
    const text = await this.run(
      vps,
      "uname -sm; if command -v tailscale >/dev/null; then tailscale status --json; fi",
      "",
      30000,
    );
    return { latencyMs: Math.round(performance.now() - start), output: text };
  }
  async exportConfig(vps: VPS) {
    const dir = join(homedir(), ".ssh", "gungun");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const hosts = this.store.all<VPS>("vps");
    const config = hosts
      .map(
        (v) =>
          `Host gungun-${v.id}\n  HostName ${v.address}\n  Port ${v.sshPort}\n  User ${v.username}\n${v.auth === "key" ? `  IdentityFile ${JSON.stringify(resolveSSHKeyPath(v.keyPath || this.store.settings().sshKeyPath || DEFAULT_SSH_KEY_PATH))}\n  IdentitiesOnly yes\n` : ""}${v.jumpId ? `  ProxyJump gungun-${v.jumpId}\n` : ""}`,
      )
      .join("\n");
    await writeFile(join(dir, "config"), config, { mode: 0o600 });
    await chmod(join(dir, "config"), 0o600);
    return {
      path: join(dir, "config"),
      command: `ssh -F ~/.ssh/gungun/config gungun-${vps.id}`,
    };
  }
  async localTailscale() {
    try {
      const { stdout } = await exec("tailscale", ["status", "--json"], {
        timeout: 8000,
      });
      return JSON.parse(stdout) as unknown;
    } catch (e) {
      return { available: false, error: String(e) };
    }
  }
  async keyStatus(path: string) {
    const resolved = resolveSSHKeyPath(path || DEFAULT_SSH_KEY_PATH);
    const privateExists = await access(resolved).then(() => true).catch(() => false);
    const publicKey = await readFile(`${resolved}.pub`, "utf8").catch(() => "");
    const publicExists = publicKey.trim().length > 0;
    return {
      path: resolved,
      privateExists,
      publicExists,
      exists: privateExists && publicExists,
      publicKey: publicExists ? publicKey.trim() : "",
    };
  }
  async installPublicKey(vps: VPS, keyPath: string) {
    const status = await this.keyStatus(keyPath);
    if (!status.exists || !status.publicKey)
      throw new Error("本机 SSH 密钥不完整，请先在设置中生成密钥");
    const parts = status.publicKey.trim().split(/\\s+/);
    if (!/^ssh-(ed25519|rsa)|^ecdsa-sha2-/.test(parts[0]) || parts.length < 2)
      throw new Error("本机公钥格式无效");
    const publicKey = parts.slice(0, 2).join(" ");
    const line = shellQuote(publicKey);
    const command =
      "umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && " +
      "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && " +
      "grep -Fqx -- " + line + " ~/.ssh/authorized_keys || " +
      "printf '%s\\n' " + line + " >> ~/.ssh/authorized_keys";
    await this.run(vps, command, "", 30000);
    const keyVps = { ...vps, auth: "key" as const, keyPath: status.path, password: "" };
    await this.test(keyVps);
    return { path: status.path, publicKey, verified: true };
  }
  async generateKey(path: string) {
    const resolved = resolveSSHKeyPath(path || DEFAULT_SSH_KEY_PATH);
    await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
    await chmod(dirname(resolved), 0o700);
    const current = await this.keyStatus(resolved);
    if (current.privateExists || current.publicExists)
      throw new Error("目标 SSH 密钥文件已存在，拒绝覆盖；如需更换请使用「轮换密钥」");
    await exec(
      "ssh-keygen",
      ["-t", "ed25519", "-f", resolved, "-N", "", "-C", "gungun"],
      { timeout: 15000 },
    );
    await chmod(resolved, 0o600);
    await chmod(`${resolved}.pub`, 0o644);
    return {
      path: resolved,
      publicKey: await readFile(`${resolved}.pub`, "utf8"),
    };
  }
}
