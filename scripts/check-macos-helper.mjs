import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error(
    "此检查必须在 Apple Silicon macOS 上执行，当前环境不能替代原生编译验收",
  );
execFileSync(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-typecheck",
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
    resolve("native/macos/ProxyHelper.swift"),
  ],
  { stdio: "inherit" },
);
console.log(
  "macOS helper Swift typecheck passed. Authorization and network changes still require real integration verification.",
);
