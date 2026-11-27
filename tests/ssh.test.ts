import { afterAll, beforeAll, describe, it, expect } from "vitest";
import ssh2 from "ssh2";
import type { Server, Connection } from "ssh2";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import { Store } from "../apps/desktop/src/main/store";
import { SSH } from "../apps/desktop/src/main/ssh";
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
  it("首次连接要求核验指纹", async () => {
    await expect(ssh.run(target, "whoami")).rejects.toThrow("HOST_KEY_UNKNOWN");
  });
  it("信任指纹后完成真实 SSH 命令", async () => {
    store.trust(`${target.address}:${target.sshPort}`, fingerprint);
    expect(await ssh.run(target, "uname -s")).toBe("executed:uname -s\n");
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
  it("认证失败给出错误，主机记录仍可保存", async () => {
    await expect(
      ssh.run({ ...target, password: "wrong" }, "whoami"),
    ).rejects.toThrow();
    store.saveVps({ ...target, password: "wrong" });
    expect(store.snapshot().vps).toHaveLength(2);
  });
});
