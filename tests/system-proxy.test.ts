import { describe, expect, it, vi } from "vitest";
import {
  ProxyController,
  type ProxyAdapter,
  type SystemProxyStatus,
} from "../apps/desktop/src/main/system-proxy";
import type {
  LocalRuntime,
  RuntimeStatus,
} from "../apps/desktop/src/main/local-runtime";
function fixture() {
  const calls: string[] = [];
  let state: RuntimeStatus["state"] = "stopped";
  const runtime = {
    initialize: async () => {},
    onUnexpected: async () => {},
    snapshot: () => ({
      state,
      port: 10808,
      active: { kind: "node", id: "node" },
    }),
    start: vi.fn(async () => {
      calls.push("core-start");
      state = "running";
    }),
    stop: vi.fn(async () => {
      calls.push("core-stop");
      state = "stopped";
    }),
  };
  let status: SystemProxyStatus = {
    enabled: false,
    conflict: false,
    port: 0,
    serviceId: "",
    error: "",
  };
  const adapter: ProxyAdapter = {
    authorize: async () => {},
    request: async <T>(action: string) => {
      calls.push(action);
      if (action === "status") return status as T;
      if (action === "services")
        return [
          {
            id: "wifi",
            name: "Wi-Fi",
            active: true,
            proxies: {
              ProxyAutoConfigEnable: 1,
              ProxyAutoConfigURLString: "https://example.com/pac",
              ExceptionsList: ["localhost"],
            },
          },
        ] as T;
      if (action === "enable")
        status = {
          enabled: true,
          conflict: false,
          port: 10808,
          serviceId: "wifi",
          error: "",
        };
      if (action === "disable")
        status = {
          enabled: false,
          conflict: false,
          port: 0,
          serviceId: "",
          error: "",
        };
      return true as T;
    },
  };
  return {
    runtime,
    calls,
    adapter,
    controller: new ProxyController(
      runtime as unknown as LocalRuntime,
      adapter,
    ),
    conflict: () => {
      status.conflict = true;
    },
  };
}
const active = { kind: "node" as const, id: "node" };
describe("系统代理事务编排（模拟辅助程序，不能替代 macOS 实机验收）", () => {
  it("先启动核心再设置网络；关闭先恢复网络再停止核心", async () => {
    const f = fixture();
    await f.controller.enable(active, [], undefined, 10808, "wifi");
    expect(f.calls.indexOf("core-start")).toBeLessThan(
      f.calls.indexOf("enable"),
    );
    await f.controller.disable();
    expect(f.calls.indexOf("disable")).toBeLessThan(
      f.calls.indexOf("core-stop"),
    );
    expect(f.controller.snapshot().enabled).toBe(false);
  });
  it("独立运行核心被系统代理复用，关闭系统代理不停止独立核心", async () => {
    const f = fixture();
    await f.controller.start(active, [], undefined, 10808);
    await f.controller.enable(active, [], undefined, 10808, "wifi");
    await f.controller.disable();
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect(f.runtime.stop).not.toHaveBeenCalled();
    await f.controller.shutdown();
  });
  it("核心启动失败不写系统设置", async () => {
    const f = fixture();
    f.runtime.start.mockRejectedValueOnce(new Error("port in use"));
    await expect(
      f.controller.enable(active, [], undefined, 10808, "wifi"),
    ).rejects.toThrow("port in use");
    expect(f.calls).not.toContain("enable");
  });
  it("非活动服务和外部修改冲突不会被覆盖", async () => {
    const f = fixture();
    await expect(
      f.controller.enable(active, [], undefined, 10808, "usb"),
    ).rejects.toThrow("活动");
    expect(f.runtime.start).not.toHaveBeenCalled();
    f.conflict();
    await expect(
      f.controller.enable(active, [], undefined, 10808, "wifi"),
    ).rejects.toThrow("冲突");
    expect(f.calls).not.toContain("enable");
  });
  it("设置一半失败时请求完整恢复；回滚失败明确报告并保留核心", async () => {
    const f = fixture();
    const base = f.adapter.request.bind(f.adapter);
    f.adapter.request = async (action, input) => {
      if (action === "enable") throw new Error("partial write");
      if (action === "disable") throw new Error("PAC restore failed");
      return base(action, input);
    };
    await expect(
      f.controller.enable(active, [], undefined, 10808, "wifi"),
    ).rejects.toThrow(/partial write.*回滚失败.*PAC restore failed/);
    expect(f.runtime.stop).not.toHaveBeenCalled();
    expect(f.controller.snapshot().error).toContain("PAC restore failed");
  });
  it("核心崩溃请求辅助程序恢复，启动时恢复旧应用会话", async () => {
    const f = fixture();
    await f.controller.enable(active, [], undefined, 10808, "wifi");
    await f.runtime.onUnexpected();
    expect(f.controller.snapshot().enabled).toBe(false);
    await f.controller.enable(active, [], undefined, 10808, "wifi");
    await f.controller.initialize();
    expect(f.controller.snapshot().enabled).toBe(false);
    await f.controller.shutdown();
  });
  it("系统代理运行中重启核心先申请切换宽限，完成后恢复监测", async () => {
    const f = fixture();
    await f.controller.enable(active, [], undefined, 10808, "wifi");
    f.calls.splice(0);
    await f.controller.start(active, [], undefined, 10808);
    expect(f.calls).toEqual(["beginSwitch", "core-start", "endSwitch"]);
    await f.controller.shutdown();
  });
  it("辅助程序返回不可读状态时不写入网络设置", async () => {
    const f = fixture();
    f.adapter.request = async <T>() => ({ enabled: true }) as T;
    await expect(
      f.controller.enable(active, [], undefined, 10808, "wifi"),
    ).rejects.toThrow();
    expect(f.runtime.start).not.toHaveBeenCalled();
  });
});
