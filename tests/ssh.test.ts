import { afterAll, beforeAll, describe, it, expect } from "vitest";
import ssh2 from "ssh2";
import type { Server, Connection } from "ssh2";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import { Store } from "../apps/desktop/src/main/store";
import {
  SSH,
  createSSHConfig,
  createSSHHostAliases,
  ensureSSHConfigInclude,
  normalizeSSHHostAlias,
} from "../apps/desktop/src/main/ssh";
import { vpsSchema, type VPS } from "../packages/domain/src/index";
let store: Store,
  ssh: SSH,
  server: Server,
  jump: Server,
  target: VPS,
  jumpVps: VPS,
  root: string,
  fingerprint: string;
const connections: Connection[] = [];
async function listen(forward: boolean) {
  const s = new ssh2.Server(
    { hostKeys: [readFileSync(join(root, "hostkey"))] },
    (client) => {
      connections.push(client);
      client.on("error", () => {});
      client.on("authentication", (ctx) =>
        ctx.method === "password" && ctx.password === "test-password"
          ? ctx.accept()
          : ctx.reject(),
      );
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (accept, _reject, info) => {
            const stream = accept();
            if (info.command === "hang") return;
            stream.write(`executed:${info.command}\n`);
            stream.exit(0);
            stream.end();
          });
        });
        if (forward)
          client.on("tcpip", (accept, reject, info) => {
            const socket = net.connect(info.destPort, info.destIP, () => {
              const stream = accept();
              socket.pipe(stream).pipe(socket);
            });
            socket.on("error", () => reject());
          });
      });
    },
  );
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return s;
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "gungun-ssh-"));
  execFileSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-f",
    join(root, "hostkey"),
    "-N",
    "",
  ]);
  const publicKey = readFileSync(join(root, "hostkey.pub"), "utf8").split(
    " ",
  )[1];
  fingerprint =
    "SHA256:" +
    createHash("sha256")
      .update(Buffer.from(publicKey, "base64"))
      .digest("base64")
      .replace(/=+$/, "");
  store = new Store(join(root, "db"));
  ssh = new SSH(store);
  server = await listen(false);
  jump = await listen(true);
  target = vpsSchema.parse({
    id: randomUUID(),
    name: "target",
    kind: "public",
    address: "127.0.0.1",
    publicAddress: "127.0.0.1",
    sshPort: (server.address() as net.AddressInfo).port,
    username: "root",
    auth: "password",
    password: "test-password",
    namespace: "a7k2p",
  });
  jumpVps = {
    ...target,
    id: randomUUID(),
    name: "jump",
    sshPort: (jump.address() as net.AddressInfo).port,
    namespace: "b9k3m",
  };
  store.saveVps(jumpVps);
  store.saveVps(target);
});
afterAll(async () => {
  for (const c of connections) c.end();
  await Promise.all(
    [server, jump].map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  store.close();
  rmSync(root, { recursive: true, force: true });
});
describe("真实 SSH 握手与跳板通道", () => {

  it("在主 SSH 配置顶部幂等添加 Gungun Include，并保留原有内容", async () => {
    const configPath = join(root, "ssh-config", "config");
    mkdirSync(dirname(configPath), { recursive: true });
    const original = "# Existing SSH settings\nHost personal\n  HostName 192.0.2.10\n  User root\n";
    writeFileSync(configPath, original, { mode: 0o644 });

    const first = await ensureSSHConfigInclude(configPath);
    const expected = [
      "# BEGIN Gungun managed include",
      "Include ~/.ssh/gungun/config",
      "# END Gungun managed include",
      "",
      original,
    ].join("\n");
    expect(first.added).toBe(true);
    expect(first.path).toBe(configPath);
    expect(readFileSync(configPath, "utf8")).toBe(expected);

    const second = await ensureSSHConfigInclude(configPath);
    expect(second.added).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(expected);
  });

  it("识别用户已经手动添加的 Gungun Include，不再插入重复项", async () => {
    const configPath = join(root, "ssh-config-existing", "config");
    mkdirSync(dirname(configPath), { recursive: true });
    const original = "Include ~/.ssh/gungun/config\nHost personal\n  User root\n";
    writeFileSync(configPath, original);

    const result = await ensureSSHConfigInclude(configPath);
    expect(result.added).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("使用 VPS 名称生成 SSH Host 别名，并让跳板引用同一别名", () => {
    const hk = { ...jumpVps, name: "hk", jumpId: null };
    const hk02 = { ...target, id: randomUUID(), name: "hk02", jumpId: null };
    const jp = { ...target, id: randomUUID(), name: "jp", jumpId: hk.id };
    const { config, aliases } = createSSHConfig(
      [hk, hk02, jp],
      join(root, "id_ed25519_gungun"),
    );

    expect(aliases.get(hk.id)).toBe("hk");
    expect(aliases.get(hk02.id)).toBe("hk02");
    expect(aliases.get(jp.id)).toBe("jp");
    expect(config).toContain("Host hk");
    expect(config).toContain("Host hk02");
    expect(config).toContain("Host jp");
    expect(config).toContain("ProxyJump hk");
    expect(config).not.toContain("gungun-");
  });

  it("重复名称自动编号，并避开已经使用的名称", () => {
    const hk = { ...jumpVps, name: "hk", jumpId: null };
    const duplicateHk = { ...target, id: randomUUID(), name: "hk", jumpId: null };
    const hk02 = { ...target, id: randomUUID(), name: "hk02", jumpId: null };
    const aliases = createSSHHostAliases([hk, duplicateHk, hk02]);

    expect(aliases.get(hk.id)).toBe("hk");
    expect(aliases.get(duplicateHk.id)).toBe("hk03");
    expect(aliases.get(hk02.id)).toBe("hk02");
    expect(normalizeSSHHostAlias("JP / Tokyo")).toBe("jp-tokyo");
    expect(normalizeSSHHostAlias("香港")).toBe("vps");
  });

  it("生成默认 Ed25519 密钥并拒绝覆盖已有密钥", async () => {
    const keyPath = join(root, "id_ed25519_gungun");
    expect((await ssh.keyStatus(keyPath)).exists).toBe(false);
    const generated = await ssh.generateKey(keyPath);
    expect(generated.path).toBe(keyPath);
    expect(generated.publicKey).toMatch(/^ssh-ed25519 /);
    expect((await ssh.keyStatus(keyPath)).exists).toBe(true);
    await expect(ssh.generateKey(keyPath)).rejects.toThrow("拒绝覆盖");
  });
  it("首次连接要求核验指纹", async () => {
    await expect(ssh.run(target, "whoami")).rejects.toThrow("HOST_KEY_UNKNOWN");
  });
  it("信任指纹后完成真实 SSH 命令", async () => {
    store.trust(`${target.address}:${target.sshPort}`, fingerprint);
    expect(await ssh.run(target, "uname -s")).toBe("executed:uname -s\n");
  });
  it("取消正在执行的 SSH 命令会关闭通道并返回 AbortError", async () => {
    const controller = new AbortController();
    const pending = ssh.run(target, "hang", "", 120000, 1024 * 1024, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("握手后 SSH socket 再次报错不会成为未处理异常", async () => {
    const connection = await ssh.connect(target);
    expect(() => connection.client.emit("error", new Error("ECONNRESET"))).not.toThrow();
    connection.close();
  });

  it("保存错误指纹会拒绝连接", async () => {
    store.trust(`${target.address}:${target.sshPort}`, "SHA256:wrong");
    await expect(ssh.run(target, "whoami")).rejects.toThrow("HOST_KEY_CHANGED");
    store.trust(`${target.address}:${target.sshPort}`, fingerprint);
  });
  it("经第一台 SSH 的 direct-tcpip 通道连接目标 SSH", async () => {
    store.trust(`${jumpVps.address}:${jumpVps.sshPort}`, fingerprint);
    expect(await ssh.run({ ...target, jumpId: jumpVps.id }, "uptime")).toBe(
      "executed:uptime\n",
    );
  });
  it("拒绝重复的 VPS 域名空间标识，且不允许修改已保存标识", () => {
    expect(() => store.saveVps({ ...target, namespace: "b9k3m" })).toThrow("创建后不可修改");
    expect(() => store.saveVps({
      ...jumpVps,
      id: randomUUID(),
      name: "duplicate namespace",
      namespace: target.namespace,
    })).toThrow("已被其他 VPS 使用");
  });
  it("认证失败给出错误，主机记录仍可保存", async () => {
    await expect(
      ssh.run({ ...target, password: "wrong" }, "whoami"),
    ).rejects.toThrow();
    store.saveVps({ ...target, password: "wrong" });
    expect(store.snapshot().vps).toHaveLength(2);
  });
});
