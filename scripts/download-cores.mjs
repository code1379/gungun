import { createHash } from "node:crypto";
import { mkdir, writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
const platform = process.env.CORE_PLATFORM || process.platform;
const arch =
  (process.env.BUILD_ARCH || process.arch) === "x64"
    ? "amd64"
    : process.env.BUILD_ARCH || process.arch;
const version = "v1.19.34";
const flavor = arch === "amd64" ? "amd64-compatible" : arch;
const assets = [
  {
    repo: "MetaCubeX/mihomo",
    version,
    name: `mihomo-${platform}-${flavor}-${version}.gz`,
    output: `mihomo-${platform}-${arch}`,
  },
];
if (process.env.WITH_SINGBOX === "1")
  assets.push({
    repo: "SagerNet/sing-box",
    version: "v1.14.4",
    name: `sing-box-1.14.4-${platform}-${arch}.tar.gz`,
    output: `sing-box-${platform}-${arch}`,
  });
const output = resolve("resources/bin");
await mkdir(output, { recursive: true });
for (const asset of assets) {
  const headers = {
    "User-Agent": "gungun-build",
    ...(process.env.GH_TOKEN
      ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
      : {}),
  };
  const metadata = await fetch(
    `https://api.github.com/repos/${asset.repo}/releases/tags/${asset.version}`,
    { headers },
  );
  if (!metadata.ok) throw new Error(`Metadata HTTP ${metadata.status}`);
  const release = await metadata.json();
  const entry = release.assets.find((a) => a.name === asset.name);
  if (!entry?.digest?.startsWith("sha256:"))
    throw new Error(`SHA256 metadata missing for ${asset.name}`);
  const response = await fetch(entry.browser_download_url, {
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
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
      executable = await readFile(
        join(dir, `sing-box-1.14.4-${platform}-${arch}`, "sing-box"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else executable = gunzipSync(bytes);
  await writeFile(join(output, asset.output), executable, { mode: 0o755 });
  console.log(`Verified ${asset.name}: ${entry.digest}`);
}
