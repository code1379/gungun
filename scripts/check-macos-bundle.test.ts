import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { verifyMacBundle } from "./check-macos-bundle.mjs";

const folders: string[] = [];
const seal = "Contents/_CodeSignature/CodeResources";
const helper = "Contents/MacOS/gungun-proxy-helper";
const registration =
  "Contents/Resources/native/gungun-service-registration.node";
const plist = "Contents/Library/LaunchDaemons/io.gungun.proxy-helper.plist";
function fixture(omit = "") {
  const folder = mkdtempSync(join(tmpdir(), "gungun 签名检查-"));
  folders.push(folder);
  const bundle = join(folder, "Gungun 测试.app");
  for (const file of [
    seal,
    "Contents/Info.plist",
    helper,
    registration,
    plist,
  ]) {
    if (file === omit) continue;
    const path = join(bundle, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture — not a real signed app");
  }
  return bundle;
}
function command(_command: string, args: string[]) {
  if (args[0] !== "-extract") return "";
  return (
    {
      CFBundleIdentifier: "io.gungun.desktop\n",
      Label: "io.gungun.proxy-helper\n",
      BundleProgram: "Contents/MacOS/gungun-proxy-helper\n",
    }[args[1]] ?? ""
  );
}
afterEach(() => {
  vi.unstubAllEnvs();
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});
describe("最终 macOS 应用签名检查（模拟系统工具，不代表真机验收）", () => {
  it("本地签名构建即使设置了 APPLE_ID，也不尝试公证或索取凭据", async () => {
    vi.stubEnv("APPLE_ID", "fixture@example.invalid");
    vi.stubEnv("APPLE_APP_SPECIFIC_PASSWORD", "");
    vi.stubEnv("APPLE_TEAM_ID", "");
    const notarize = createRequire(import.meta.url)("./notarize.cjs");
    await expect(
      notarize({
        electronPlatformName: "darwin",
        packager: { platformSpecificBuildOptions: { identity: "-" } },
      }),
    ).resolves.toBeUndefined();
  });
  it("检查应用、助手和注册模块签名，支持中文与空格路径", () => {
    const bundle = fixture();
    const run = vi.fn(command);
    expect(verifyMacBundle(bundle, { platform: "darwin", run })).toBe(bundle);
    expect(
      run.mock.calls.filter(([tool]) => tool === "/usr/bin/codesign"),
    ).toEqual(
      [helper, registration, ""].map((file) => [
        "/usr/bin/codesign",
        [
          "--verify",
          "--deep",
          "--strict",
          "--verbose=2",
          file ? join(bundle, file) : bundle,
        ],
        { encoding: "utf8", stdio: "pipe" },
      ]),
    );
    expect(
      run.mock.calls.every(([tool]) =>
        ["/usr/bin/plutil", "/usr/bin/codesign"].includes(tool),
      ),
    ).toBe(true);
  });
  it("缺资源签名封装时拒绝，不接受 Electron 原二进制的残留签名", () => {
    const run = vi.fn(command);
    expect(() =>
      verifyMacBundle(fixture(seal), { platform: "darwin", run }),
    ).toThrow("CodeResources");
    expect(run).not.toHaveBeenCalled();
  });
  it("缺少 / 空的原生产物和 plist 均拒绝", () => {
    for (const file of [helper, registration, plist]) {
      const bundle = fixture(file);
      expect(() =>
        verifyMacBundle(bundle, { platform: "darwin", run: command }),
      ).toThrow(file);
      mkdirSync(dirname(join(bundle, file)), { recursive: true });
      writeFileSync(join(bundle, file), "");
      expect(() =>
        verifyMacBundle(bundle, { platform: "darwin", run: command }),
      ).toThrow("为空");
    }
  });
  it("错误的主应用标识或 LaunchDaemon 配置阻止通过", () => {
    for (const key of ["CFBundleIdentifier", "Label", "BundleProgram"]) {
      expect(() =>
        verifyMacBundle(fixture(), {
          platform: "darwin",
          run: (tool: string, args: string[]) =>
            args[0] === "-extract" && args[1] === key
              ? "wrong"
              : command(tool, args),
        }),
      ).toThrow(`应用配置不匹配：${key}`);
    }
  });
  it.each([helper, registration, ""])(
    "签名校验失败保留真实原因和路径：%s",
    (file) => {
      const bundle = fixture();
      const target = file ? join(bundle, file) : bundle;
      expect(() =>
        verifyMacBundle(bundle, {
          platform: "darwin",
          run: (tool: string, args: string[]) => {
            if (tool === "/usr/bin/codesign" && args.at(-1) === target)
              throw Object.assign(new Error("Command failed"), {
                stderr: Buffer.from(
                  "code has no resources but signature indicates they must be present",
                ),
              });
            return command(tool, args);
          },
        }),
      ).toThrow(`${target}；code has no resources`);
    },
  );
  it("非 macOS 不执行系统工具或伪称签名已通过", () => {
    const run = vi.fn(command);
    expect(() =>
      verifyMacBundle("/unused", { platform: "linux", run }),
    ).toThrow("真实 macOS");
    expect(run).not.toHaveBeenCalled();
  });
});
