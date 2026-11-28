import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import release from "../../../../resources/core-release.json";
const exec = promisify(execFile);
export async function ensureLocalCore(
  resources: string,
  dataDir: string,
  download = false,
) {
  const platform = process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const name = `sing-box-${platform}-${arch}`;
  for (const path of [join(resources, name), join(dataDir, "core", name)]) {
    try {
      await access(path);
      const { stdout } = await exec(path, ["version"], {
        timeout: 10000,
        maxBuffer: 65536,
      });
      if (stdout.startsWith(`sing-box version ${release.version}\n`))
        return path;
    } catch {
      /* Try the downloaded copy. */
    }
  }
  if (!download)
    throw new Error("本机 sing-box 尚未安装，请在设置中下载并检查核心");
  if (!["darwin", "linux"].includes(platform))
    throw new Error("当前平台不支持本机核心");
  const directory = join(dataDir, "core");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temp = await mkdtemp(join(directory, "download-"));
  try {
    const response = await fetch(
      `https://api.github.com/repos/${release.repo}/releases/tags/v${release.version}`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok)
      throw new Error(`核心发布信息读取失败：HTTP ${response.status}`);
    const metadata = (await response.json()) as {
      assets: {
        name: string;
        digest?: string;
        browser_download_url: string;
        size: number;
      }[];
    };
    const archive = `sing-box-${release.version}-${platform}-${arch}.tar.gz`;
    const asset = metadata.assets.find((a) => a.name === archive);
    if (
      !asset?.digest?.startsWith("sha256:") ||
      !asset.browser_download_url.startsWith(
        `https://github.com/${release.repo}/releases/download/`,
      )
    )
      throw new Error("发布包缺少可信 SHA256 元数据");
    const downloadResponse = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(180000),
    });
    if (!downloadResponse.ok)
      throw new Error(`下载失败：HTTP ${downloadResponse.status}`);
    const bytes = Buffer.from(await downloadResponse.arrayBuffer());
    if (
      bytes.length !== asset.size ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        asset.digest
    )
      throw new Error("核心文件 SHA256 / 长度校验失败");
    await writeFile(join(temp, "core.tar.gz"), bytes, { mode: 0o600 });
    await exec(
      "/usr/bin/tar",
      [
        "-xzf",
        join(temp, "core.tar.gz"),
        "-C",
        temp,
        `sing-box-${release.version}-${platform}-${arch}/sing-box`,
      ],
      { timeout: 30000 },
    );
    const binary = await readFile(
      join(temp, `sing-box-${release.version}-${platform}-${arch}/sing-box`),
    );
    const stage = join(temp, name);
    await writeFile(stage, binary, { mode: 0o700 });
    const { stdout } = await exec(stage, ["version"], { timeout: 10000 });
    if (!stdout.startsWith(`sing-box version ${release.version}\n`))
      throw new Error("核心版本校验失败");
    await rename(stage, join(directory, name));
    return join(directory, name);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
