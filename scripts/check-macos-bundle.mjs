import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultBundle = join(root, "release/mac-arm64/Gungun.app");

// Validate the final signed app, after electron-builder has finished all writes.
// This does not register a daemon, request approval, or change network settings.
export function verifyMacBundle(
  bundle = defaultBundle,
  { platform = process.platform, run = execFileSync } = {},
) {
  if (platform !== "darwin")
    throw new Error("应用签名检查必须在真实 macOS 上执行");
  bundle = resolve(bundle);
  const contents = join(bundle, "Contents");
  const helper = join(contents, "MacOS/gungun-proxy-helper");
  const registration = join(
    contents,
    "Resources/native/gungun-service-registration.node",
  );
  const plist = join(
    contents,
    "Library/LaunchDaemons/io.gungun.proxy-helper.plist",
  );
  for (const file of [
    join(contents, "_CodeSignature/CodeResources"),
    join(contents, "Info.plist"),
    helper,
    registration,
    plist,
  ]) {
    let valid = false;
    try {
      const stat = statSync(file);
      valid = stat.isFile() && stat.size > 0;
    } catch {
      // Provide the missing path instead of accepting an Electron executable's
      // leftover vendor signature as a signature for the repackaged app.
    }
    if (!valid)
      throw new Error(
        `应用签名或打包产物缺失 / 为空：${file}；请重新运行 pnpm package:mac:dir`,
      );
  }
  function check(command, args) {
    try {
      return run(command, args, { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      const detail = error?.stderr?.toString().trim() || error.message;
      throw new Error(`应用签名 / 配置检查失败：${args.at(-1)}；${detail}`);
    }
  }
  for (const [key, expected] of [
    ["CFBundleIdentifier", "io.gungun.desktop"],
    ["Label", "io.gungun.proxy-helper"],
    ["BundleProgram", "Contents/MacOS/gungun-proxy-helper"],
  ]) {
    const path =
      key === "CFBundleIdentifier" ? join(contents, "Info.plist") : plist;
    const actual = check("/usr/bin/plutil", [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      path,
    ]).trim();
    if (actual !== expected)
      throw new Error(
        `应用配置不匹配：${key}=${actual}；预期 ${expected}；${path}`,
      );
  }
  for (const path of [helper, registration, bundle])
    check("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      path,
    ]);
  return bundle;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const bundle = verifyMacBundle(process.argv[2]);
  console.log(`应用及系统代理原生产物签名检查通过：${bundle}`);
  console.log(
    "此检查不代表 SMAppService 注册、系统批准或系统代理写入已通过真机验收。",
  );
}
