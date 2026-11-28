import { createHash } from "node:crypto";
import { mkdir, writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { downloadBuffer, fetchJson } from "./download-utils.mjs";
const releaseInfo = JSON.parse(await readFile(new URL("../resources/core-release.json", import.meta.url), "utf8"));
const platform = process.env.CORE_PLATFORM || process.platform;
const arch =
  (process.env.BUILD_ARCH || process.arch) === "x64"
    ? "amd64"
    : process.env.BUILD_ARCH || process.arch;
const assets = [
  {
    repo: releaseInfo.repo,
    version: `v${releaseInfo.version}`,
    name: `sing-box-${releaseInfo.version}-${platform}-${arch}.tar.gz`,
    output: `sing-box-${platform}-${arch}`,
    executable: `sing-box-${releaseInfo.version}-${platform}-${arch}/sing-box`,
  },
];
if (process.env.WITH_CADDY === "1") {
  assets.push({
    repo: "caddyserver/caddy",
    version: "v2.10.2",
    name: `caddy_2.10.2_${platform}_${arch}.tar.gz`,
    output: `caddy-${platform}-${arch}`,
    executable: "caddy",
  });
}
const output = resolve("resources/bin");
await mkdir(output, { recursive: true });
for (const asset of assets) {
  const headers = {
    "User-Agent": "gungun-build",
    ...(process.env.GH_TOKEN
      ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
      : {}),
  };
  const release = await fetchJson(
    `https://api.github.com/repos/${asset.repo}/releases/tags/${asset.version}`,
    { headers, label: `${asset.repo} ${asset.version} 发布信息` },
  );
  const entry = release.assets.find((a) => a.name === asset.name);
  if (!entry?.digest?.startsWith("sha256:"))
    throw new Error(`SHA256 metadata missing for ${asset.name}`);
  const outputPath = join(output, asset.output);
  const markerPath = outputPath + ".sha256.json";
  try {
    const [existing, markerText] = await Promise.all([
      readFile(outputPath),
      readFile(markerPath, "utf8"),
    ]);
    const marker = JSON.parse(markerText);
    const existingDigest = createHash("sha256").update(existing).digest("hex");
    if (marker.releaseDigest === entry.digest && marker.binaryDigest === existingDigest) {
      console.log(`已使用本地校验缓存：${asset.name}`);
      continue;
    }
  } catch {
    // 首次下载或缓存不完整时重新下载并校验。
  }
  const bytes = await downloadBuffer(entry.browser_download_url, {
    label: asset.name,
    expectedSize: entry.size,
    timeoutMs: 180000,
  });
  if (
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
    entry.digest
  )
    throw new Error("SHA256 mismatch");
  let executable;
  if (asset.name.endsWith(".tar.gz")) {
    const dir = await mkdtemp(join(tmpdir(), "gungun-extract-"));
    try {
      await writeFile(join(dir, "core.tar.gz"), bytes);
      execFileSync("tar", ["-xzf", join(dir, "core.tar.gz"), "-C", dir]);
      executable = await readFile(join(dir, asset.executable));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else throw new Error("Unsupported core archive");
  await writeFile(outputPath, executable, { mode: 0o755 });
  const binaryDigest = createHash("sha256").update(executable).digest("hex");
  await writeFile(
    markerPath,
    JSON.stringify({ releaseDigest: entry.digest, binaryDigest }, null, 2),
    { mode: 0o600 },
  );
  console.log(`Verified ${asset.name}: ${entry.digest}`);
}
