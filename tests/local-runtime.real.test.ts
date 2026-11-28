import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  availablePort,
  LocalRuntime,
  redactLog,
} from "../apps/desktop/src/main/local-runtime";
import { nodeSchema, type Chain } from "../packages/domain/src/index";
import { createCoreReadiness } from "../apps/desktop/src/main/core-readiness";
const exec = promisify(execFile);
const core =
  process.env.SING_BOX_BINARY ||
  resolve(
    `resources/bin/sing-box-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`,
  );
const supervisor = resolve("resources/helpers/core-supervisor.cjs");
const target = createServer((_req, res) => {
  res.end("actual-local-proxy");
});
let dir: string;
let originPort: number;
let serverPort: number;
let listenPort: number;
let server: ReturnType<typeof spawn>;
let probe: Awaited<ReturnType<typeof createCoreReadiness>>;
let runtime: LocalRuntime;
const active = { kind: "node" as const, id: "one" };
function node(id = "one") {
  return nodeSchema.parse({
    id,
    name: `node-${id}`,
    protocol: "snell",
    password: "private-snell-secret",
    address: "127.0.0.1",
    port: serverPort,
    tagId: "manual",
  });
}
async function proxyRequest(port: number, protocol: string) {
  const { stdout } = await exec("/usr/bin/curl", [
    "--silent",
    "--fail",
    "--noproxy",
    "",
    "--proxy",
    `${protocol}://127.0.0.1:${port}`,
    "--max-time",
    "5",
    `http://127.0.0.1:${originPort}/`,
  ]);
  return stdout;
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gungun-runtime-integration-"));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  originPort = (target.address() as import("node:net").AddressInfo).port;
  serverPort = await availablePort();
  listenPort = await availablePort();
  const config = {
    inbounds: [
      {
        type: "snell",
        listen: "127.0.0.1",
        listen_port: serverPort,
        psk: "private-snell-secret",
        version: 6,
        mode: "default",
      },
    ],
    outbounds: [{ type: "direct", tag: "direct" }],
    route: { final: "direct" },
  };
  probe = await createCoreReadiness(config);
  await writeFile(join(dir, "server.json"), JSON.stringify(config));
  server = spawn(core, ["run", "-c", join(dir, "server.json")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let runtimeLog = "";
  server.stderr?.on("data", (b: Buffer) => {
    runtimeLog += b.toString();
  });
  let failed = false;
  server.once("error", () => (failed = true));
  server.once("exit", () => (failed = true));
  await probe
    .wait(() => failed)
    .catch((e) => {
      throw new Error(String(e) + runtimeLog);
    });
  runtime = new LocalRuntime(
    async () => core,
    join(dir, "runtime"),
    () => {},
    supervisor,
    () => `http://127.0.0.1:${originPort}/`,
  );
});
afterAll(async () => {
  await runtime?.stop();
  server?.kill();
  await probe?.close();
  await new Promise<void>((r) => target.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});
describe("本机 sing-box 1.14.4 真实进程", () => {
  it("启动后同一 mixed inbound 支持真实 HTTP 和 SOCKS，配置权限严格", async () => {
    await runtime.start(active, [node()], undefined, listenPort);
    expect(runtime.snapshot().state).toBe("running");
    expect(await proxyRequest(listenPort, "http")).toBe("actual-local-proxy");
    expect(await proxyRequest(listenPort, "socks5h")).toBe(
      "actual-local-proxy",
    );
    const files = await readdir(join(dir, "runtime"));
    expect(files).toHaveLength(1);
    const path = join(dir, "runtime", files[0], "config.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain('"listen":"127.0.0.1"');
  });
  it("能力校验错误、配置检查错误和端口占用不会破坏当前代理", async () => {
    const invalid = node("invalid");
    invalid.publicKey = "";
    invalid.protocol = "vless-reality";
    invalid.uuid = "uuid";
    await expect(
      runtime.start(
        { kind: "node", id: "invalid" },
        [invalid],
        undefined,
        listenPort,
      ),
    ).rejects.toThrow("公钥");
    const badConfig = node("bad-config");
    badConfig.protocol = "vless-reality";
    badConfig.uuid = "43756003-c175-4ba4-97f7-11537146b95b";
    badConfig.publicKey = "invalid-reality-public-key";
    await expect(
      runtime.start(
        { kind: "node", id: "bad-config" },
        [badConfig],
        undefined,
        listenPort,
      ),
    ).rejects.toThrow();
    expect(await proxyRequest(listenPort, "socks5h")).toBe(
      "actual-local-proxy",
    );
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    try {
      await expect(
        runtime.start(
          active,
          [node()],
          undefined,
          (blocker.address() as import("node:net").AddressInfo).port,
        ),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
    expect(runtime.snapshot().active).toEqual(active);
    expect(await proxyRequest(listenPort, "http")).toBe("actual-local-proxy");
  });
  it("节点切换与双跳链路沿用节点 ID 引用，正式端口保持一致", async () => {
    const chain: Chain = {
      id: "chain",
      name: "two hops",
      nodeIds: ["one", "two"],
    };
    await runtime.start(
      { kind: "chain", id: chain.id },
      [node(), node("two")],
      chain,
      listenPort,
    );
    expect(runtime.snapshot().active).toEqual({ kind: "chain", id: "chain" });
    expect(await proxyRequest(listenPort, "socks5h")).toBe(
      "actual-local-proxy",
    );
    await runtime.start(active, [node()], undefined, listenPort);
  });
  it("运行进程异常退出会通知网络恢复并清理配置文件", async () => {
    let recovered = false;
    runtime.onUnexpected = async () => {
      recovered = true;
    };
    const internal = runtime as unknown as {
      running: { child: ReturnType<typeof spawn> };
    };
    internal.running.child.kill("SIGTERM");
    await expect.poll(() => recovered).toBe(true);
    await expect.poll(() => runtime.snapshot().state).toBe("error");
    await expect
      .poll(async () => (await readdir(join(dir, "runtime"))).length)
      .toBe(0);
    await expect(proxyRequest(listenPort, "http")).rejects.toThrow();
  });
  it("重新启动和停止释放端口；日志不暴露凭据", async () => {
    await runtime.start(active, [node()], undefined, listenPort);
    await runtime.stop();
    expect(await availablePort(listenPort)).toBe(listenPort);
    expect(runtime.snapshot().state).toBe("stopped");
    expect(
      redactLog("password=secret uuid=457b2d26-5b0f-4a1f-bb50-0dbe1a699c67", [
        "secret",
      ]),
    ).not.toContain("secret");
    expect(runtime.snapshot().logs.join("")).not.toContain(
      "private-snell-secret",
    );
  });
});
