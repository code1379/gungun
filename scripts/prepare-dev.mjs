import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) throw new Error("Gungun 开发环境需要 Node.js 24 或更新版本");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("一键开发环境准备目前支持 macOS Apple Silicon（M 系列芯片）");

function run(script) {
  execFileSync(process.execPath, [join(root, script)], { cwd: root, stdio: "inherit" });
}

console.log("[1/2] 准备 Go 并构建 Linux fq amd64 / arm64");
run("scripts/build-fq.mjs");
console.log("[2/2] 下载并校验 macOS arm64 sing-box");
run("scripts/download-cores.mjs");
console.log("准备完成。现在可以运行 pnpm dev");
