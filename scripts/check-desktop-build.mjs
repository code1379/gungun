import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

async function requireFile(path) {
  try {
    if ((await stat(path)).isFile()) return;
  } catch {
    /* Report a build failure below. */
  }
  throw new Error(
    `桌面生产构建缺少文件：${path}。请先执行 pnpm --filter @gungun/desktop build，不能打包开发模式产物。`,
  );
}
export async function assertDesktopBuild(directory) {
  const appDir = resolve(directory);
  const manifest = JSON.parse(
    await readFile(resolve(appDir, "package.json"), "utf8"),
  );
  if (typeof manifest.main !== "string")
    throw new Error("桌面 package.json 缺少 main 入口");
  await requireFile(resolve(appDir, manifest.main));
  await requireFile(resolve(appDir, "out/preload/index.cjs"));
  const renderer = resolve(appDir, "out/renderer");
  const index = resolve(renderer, "index.html");
  await requireFile(index);
  const html = await readFile(index, "utf8");
  const scripts = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
  ].map((m) => m[1]);
  if (!scripts.length)
    throw new Error("桌面生产页面没有编译后的 JavaScript 入口，请重新构建");
  const styles = [
    ...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi),
  ].map((m) => m[1]);
  for (const reference of [...scripts, ...styles]) {
    if (
      reference.startsWith("/") ||
      /^[a-z][a-z0-9+.-]*:/i.test(reference) ||
      reference.includes("/src/") ||
      reference.includes("@vite/")
    )
      throw new Error(
        `桌面页面引用了开发服务器或绝对资源路径：${reference}，请重新构建生产页面`,
      );
    let path;
    try {
      path = resolve(renderer, decodeURIComponent(reference.split(/[?#]/)[0]));
    } catch {
      throw new Error("桌面页面的资源路径无法解析，请重新构建");
    }
    const inside = relative(renderer, path);
    if (inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside))
      throw new Error("桌面页面的资源引用超出 renderer 目录");
    await requireFile(path);
  }
}
// electron-builder beforePack hook. Also guards direct electron-builder invocations.
export default async function beforePack(context) {
  await assertDesktopBuild(context.packager.info.appDir);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await assertDesktopBuild(process.argv[2] || resolve(root, "apps/desktop"));
  console.log(
    "Desktop production main, preload, renderer and referenced assets verified.",
  );
}
