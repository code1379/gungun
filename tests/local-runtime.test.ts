import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { nodeSchema } from "../packages/domain/src/index";
import {
  availablePort,
  LocalRuntime,
} from "../apps/desktop/src/main/local-runtime";
let directory: string;
let runtime: LocalRuntime;
let port: number;
const active = { kind: "node" as const, id: "working" };
const node = (address = "127.0.0.1", value = 443) =>
  nodeSchema.parse({
    id: address,
    name: address,
    protocol: "snell",
    address,
    port: value,
    password: "hidden-test-password",
    tagId: "test",
  });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gungun-state-test-"));
  port = await availablePort();
  runtime = new LocalRuntime(
    async () => resolve("tests/fixtures/mock-core.cjs"),
    directory,
    () => {},
    resolve("resources/helpers/core-supervisor.cjs"),
  );
});
afterEach(async () => {
  await runtime.stop();
  delete process.env.GUNGUN_FIXTURE_FAILURE_MARKER;
  await rm(directory, { recursive: true, force: true });
});
describe("本机核心生命周期（模拟核心进程，不代替 sing-box 实测）", () => {
  it("启动、重启和停止；权限和资源清理", async () => {
    await runtime.start(active, [node()], undefined, port);
    expect(runtime.snapshot().state).toBe("running");
    const runs = await readdir(directory);
    expect(runs).toHaveLength(1);
    expect(
      (await stat(join(directory, runs[0], "config.json"))).mode & 0o777,
    ).toBe(0o600);
    await runtime.start(active, [node()], undefined, port);
    expect(await readdir(directory)).toHaveLength(1);
    await runtime.stop();
    expect(await readdir(directory)).toHaveLength(0);
    expect(await availablePort(port)).toBe(port);
  });
  it("配置错误和端口冲突保留当前正常进程", async () => {
    await runtime.start(active, [node()], undefined, port);
    await expect(
      runtime.start(
        { kind: "node", id: "bad" },
        [node("invalid-config")],
        undefined,
        port,
      ),
    ).rejects.toThrow("配置校验失败");
    expect(runtime.snapshot().state).toBe("running");
    expect(runtime.snapshot().active).toEqual(active);
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
  });
  it("正式切换阶段启动失败后恢复旧配置和活动节点", async () => {
    await runtime.start(active, [node()], undefined, port);
    process.env.GUNGUN_FIXTURE_FAILURE_MARKER = join(directory, "failed-once");
    await expect(
      runtime.start(
        { kind: "node", id: "bad" },
        [node("fail-cutover", port)],
        undefined,
        port,
      ),
    ).rejects.toThrow("启动失败");
    expect(runtime.snapshot().state).toBe("running");
    expect(runtime.snapshot().active).toEqual(active);
    // One marker plus exactly one restored runtime directory.
    expect(await readdir(directory)).toHaveLength(2);
  });
  it("意外退出触发系统恢复并删除运行配置", async () => {
    let recovered = false;
    runtime.onUnexpected = async () => {
      recovered = true;
    };
    await runtime.start(active, [node()], undefined, port);
    (
      runtime as unknown as {
        running: { child: import("node:child_process").ChildProcess };
      }
    ).running.child.kill("SIGTERM");
    await expect.poll(() => recovered).toBe(true);
    await expect.poll(async () => (await readdir(directory)).length).toBe(0);
    expect(runtime.snapshot().state).toBe("error");
    expect(await availablePort(port)).toBe(port);
  });
});
