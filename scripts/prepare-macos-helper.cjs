/* eslint @typescript-eslint/no-require-imports: "off", no-undef: "off" */
const { execFileSync } = require("node:child_process");
const { mkdirSync, copyFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
module.exports = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  const root = resolve(__dirname, "..");
  const contents = join(context.appOutDir, "Gungun.app", "Contents");
  mkdirSync(join(contents, "Library", "LaunchDaemons"), { recursive: true });
  execFileSync(
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
  copyFileSync(
    join(root, "native/macos/io.gungun.proxy-helper.plist"),
    join(contents, "Library/LaunchDaemons/io.gungun.proxy-helper.plist"),
  );
};
