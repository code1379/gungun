import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { downloadBuffer, fetchJson } from "./download-utils.mjs";

export const GO_VERSION = "1.25.4";
const toolsDir = resolve(".tools");
const goRoot = join(toolsDir, "go");
const localGo = join(goRoot, "bin", "go");

function versionOf(binary) {
  try {
    return execFileSync(binary, ["version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function isPinned(binary) {
  return versionOf(binary).includes("go" + GO_VERSION);
}

export function findGoArchive(releases, goos = "darwin", goarch = "arm64") {
  const release = releases.find((item) => item.version === "go" + GO_VERSION);
  const filename = "go" + GO_VERSION + "." + goos + "-" + goarch + ".tar.gz";
  const asset = release?.files?.find(
    (item) => item.filename === filename && item.kind === "archive",
  );
  if (!asset?.sha256 || !/^[a-f0-9]{64}$/i.test(asset.sha256)) return undefined;
  return asset;
}

export function sha256Matches(bytes, expected) {
  if (!/^[a-f0-9]{64}$/i.test(expected || "")) return false;
  return createHash("sha256").update(bytes).digest("hex") === expected.toLowerCase();
}

export async function ensureGo() {
  if (process.env.GO_BINARY) {
    const binary = resolve(process.env.GO_BINARY);
    if (!isPinned(binary))
      throw new Error("GO_BINARY 必须指向 Go " + GO_VERSION + "：" + binary);
    return binary;
  }
  if (isPinned(localGo)) return localGo;
  if (isPinned("go")) return "go";
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("未找到 Go " + GO_VERSION + "。自动准备目前支持 macOS Apple Silicon；其他平台请安装 Go " + GO_VERSION + "。");

  console.log("正在将 Go " + GO_VERSION + " 安装到项目 .tools/go（不修改系统环境）...");
  const releases = await fetchJson("https://go.dev/dl/?mode=json&include=all", {
    label: "获取 Go 官方版本元数据",
    timeoutMs: 30000,
  });
  const asset = findGoArchive(releases);
  if (!asset) throw new Error("Go 官方元数据缺少带 SHA256 的 macOS arm64 归档");

  const archive = await downloadBuffer("https://go.dev/dl/" + asset.filename, {
    label: "Go " + GO_VERSION + " macOS arm64 工具链",
    expectedSize: asset.size,
    timeoutMs: 300000,
  });
  if (!sha256Matches(archive, asset.sha256))
    throw new Error("Go 工具链 SHA256 校验失败，拒绝安装");

  await mkdir(toolsDir, { recursive: true });
  const archivePath = join(toolsDir, asset.filename);
  await rm(goRoot, { recursive: true, force: true });
  try {
    await writeFile(archivePath, archive, { mode: 0o600 });
    execFileSync("tar", ["-xzf", archivePath, "-C", toolsDir], { stdio: "inherit" });
  } finally {
    await rm(archivePath, { force: true });
  }
  if (!isPinned(localGo)) throw new Error("Go 工具链安装后版本校验失败");
  console.log("Go 工具链准备完成：" + versionOf(localGo).trim());
  return localGo;
}
