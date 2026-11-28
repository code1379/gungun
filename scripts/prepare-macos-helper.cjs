/* eslint @typescript-eslint/no-require-imports: "off", no-undef: "off" */
const { execFileSync } = require("node:child_process");
const { mkdirSync, copyFileSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { include_dir } = require("node-api-headers");
function registrationArgs(root, output) {
  return [
    "clang++",
    "-std=c++17",
    "-fobjc-arc",
    "-O2",
    "-arch",
    "arm64",
    "-mmacosx-version-min=13.0",
    "-DNAPI_VERSION=8",
    "-I",
    include_dir,
    "-framework",
    "Foundation",
    "-framework",
    "ServiceManagement",
    join(root, "native/macos/ServiceRegistration.mm"),
    ...(output
      ? ["-bundle", "-undefined", "dynamic_lookup", "-o", output]
      : ["-fsyntax-only"]),
  ];
}
module.exports = async (context, run = execFileSync) => {
  if (context.electronPlatformName !== "darwin") return;
  const root = resolve(__dirname, "..");
  const contents = join(
    context.appOutDir,
    context.packager.appInfo.productFilename + ".app",
    "Contents",
  );
  const registration = join(
    contents,
    "Resources/native/gungun-service-registration.node",
  );
  mkdirSync(join(contents, "Library", "LaunchDaemons"), { recursive: true });
  mkdirSync(join(contents, "Resources", "native"), { recursive: true });
  run(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-O",
      "-target",
      "arm64-apple-macos13.0",
      "-framework",
      "Foundation",
      "-framework",
      "SystemConfiguration",
      "-framework",
      "ServiceManagement",
      "-framework",
      "Security",
      join(root, "native/macos/ProxyHelper.swift"),
      "-o",
      join(contents, "MacOS/gungun-proxy-helper"),
    ],
    { stdio: "inherit" },
  );
  run("/usr/bin/xcrun", registrationArgs(root, registration), {
    stdio: "inherit",
  });
  copyFileSync(
    join(root, "native/macos/io.gungun.proxy-helper.plist"),
    join(contents, "Library/LaunchDaemons/io.gungun.proxy-helper.plist"),
  );
  // Fail the package before signing if any native component is absent or empty.
  for (const file of [
    registration,
    join(contents, "MacOS/gungun-proxy-helper"),
    join(contents, "Library/LaunchDaemons/io.gungun.proxy-helper.plist"),
  ]) {
    if (!statSync(file).isFile() || statSync(file).size === 0)
      throw new Error("系统代理原生打包产物缺失或为空：" + file);
  }
};
module.exports.registrationArgs = registrationArgs;
