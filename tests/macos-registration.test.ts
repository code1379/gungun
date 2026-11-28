import { describe, expect, it, vi } from "vitest";
import { registerMacProxyService } from "../apps/desktop/src/main/macos-registration";

const helper =
  "/Applications/Gungun 测试.app/Contents/MacOS/gungun-proxy-helper";
const result = {
  status: "enabled",
  bundlePath: "/Applications/Gungun 测试.app",
  plistPath:
    "/Applications/Gungun 测试.app/Contents/Library/LaunchDaemons/io.gungun.proxy-helper.plist",
};
describe("主进程系统代理注册边界（原生接口为模拟，非 macOS 授权验收）", () => {
  it("直接加载 app 外置的 Node-API 模块并调用，支持空格与中文路径", () => {
    const registerService = vi.fn(() => JSON.stringify(result));
    const load = vi.fn(() => ({ registerService }));
    expect(registerMacProxyService(helper, "darwin", load)).toEqual(result);
    expect(load).toHaveBeenCalledWith(
      "/Applications/Gungun 测试.app/Contents/Resources/native/gungun-service-registration.node",
    );
    expect(registerService).toHaveBeenCalledExactlyOnceWith();
  });
  it("待系统批准不误报已授权", () => {
    expect(
      registerMacProxyService(helper, "darwin", () => ({
        registerService: () =>
          JSON.stringify({ ...result, status: "requiresApproval" }),
      })),
    ).toEqual({ ...result, status: "requiresApproval" });
  });
  it("非 macOS 或开发模式不会加载注册模块", () => {
    const load = vi.fn();
    expect(() => registerMacProxyService(helper, "linux", load)).toThrow(
      "macOS",
    );
    expect(() => registerMacProxyService(undefined, "darwin", load)).toThrow(
      "开发模式",
    );
    expect(load).not.toHaveBeenCalled();
  });
  it("缺失或无法加载的 native 模块报告实际文件和原错误", () => {
    expect(() =>
      registerMacProxyService(helper, "darwin", () => {
        throw new Error("code signature invalid");
      }),
    ).toThrow(/gungun-service-registration\.node；code signature invalid/);
  });
  it("保留原生错误域、错误码和 Bundle 诊断，不改写为文件缺失", () => {
    const message =
      "注册失败 (SMAppServiceErrorDomain:108)；Bundle：/Applications/Gungun.app";
    expect(() =>
      registerMacProxyService(helper, "darwin", () => ({
        registerService: () => {
          throw new Error(message);
        },
      })),
    ).toThrow(message);
  });
  it("未知状态与不完整原生响应不能当作授权成功", () => {
    for (const status of ["notFound", "notRegistered", "unknown", ""]) {
      expect(() =>
        registerMacProxyService(helper, "darwin", () => ({
          registerService: () => JSON.stringify({ ...result, status }),
        })),
      ).toThrow();
    }
    for (const reply of [undefined, "not-json", "{}", '{"status":"enabled"}']) {
      expect(() =>
        registerMacProxyService(helper, "darwin", () => ({
          registerService: () => reply,
        })),
      ).toThrow();
    }
  });
  it("无效模块接口停止流程", () => {
    for (const native of [null, {}, { registerService: "no" }]) {
      expect(() =>
        registerMacProxyService(helper, "darwin", () => native),
      ).toThrow("接口无效");
    }
  });
});
