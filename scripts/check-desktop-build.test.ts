import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertDesktopBuild,
  default as beforePack,
} from "./check-desktop-build.mjs";
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture(renderer = true) {
  const path = await mkdtemp(join(tmpdir(), "gungun packaged app 空格-"));
  folders.push(path);
  await mkdir(join(path, "out/main"), { recursive: true });
  await mkdir(join(path, "out/preload"), { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ main: "out/main/index.js" }),
  );
  await writeFile(join(path, "out/main/index.js"), "// main");
  await writeFile(join(path, "out/preload/index.cjs"), "// preload");
  if (renderer) {
    await mkdir(join(path, "out/renderer/assets"), { recursive: true });
    await writeFile(
      join(path, "out/renderer/index.html"),
      '<script type="module" src="./assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">',
    );
    await writeFile(
      join(path, "out/renderer/assets/app.js"),
      "// compiled renderer",
    );
    await writeFile(join(path, "out/renderer/assets/app.css"), "body{}");
  }
  return path;
}
describe("桌面打包前的生产资源检查", () => {
  it("拒绝仅有 main/preload 的开发模式产物，复现白屏缺失页面场景", async () => {
    await expect(assertDesktopBuild(await fixture(false))).rejects.toThrow(
      "out/renderer/index.html",
    );
  });
  it("接受中文及空格目录下的完整生产资源，beforePack 走相同校验", async () => {
    const path = await fixture();
    await expect(
      beforePack({ packager: { info: { appDir: path } } }),
    ).resolves.toBeUndefined();
  });
  it("生产 HTML 引用的 JavaScript 缺失时拒绝打包", async () => {
    const path = await fixture();
    await rm(join(path, "out/renderer/assets/app.js"));
    await expect(assertDesktopBuild(path)).rejects.toThrow("assets/app.js");
  });
  it("拒绝旧的开发 HTML 和开发服务器资源", async () => {
    const path = await fixture();
    for (const ref of [
      "/src/main.tsx",
      "http://localhost:5173/src/main.tsx",
      "./@vite/client",
    ]) {
      await writeFile(
        join(path, "out/renderer/index.html"),
        `<script src="${ref}"></script>`,
      );
      await expect(assertDesktopBuild(path)).rejects.toThrow("开发服务器");
    }
  });
  it("没有脚本的空页面不能通过生产资源校验", async () => {
    const path = await fixture();
    await writeFile(
      join(path, "out/renderer/index.html"),
      '<div id="root"></div>',
    );
    await expect(assertDesktopBuild(path)).rejects.toThrow("JavaScript 入口");
  });
  it("拒绝编码后的越界资源引用", async () => {
    const path = await fixture();
    await writeFile(
      join(path, "out/renderer/index.html"),
      '<script src="%2e%2e/main/index.js"></script>',
    );
    await expect(assertDesktopBuild(path)).rejects.toThrow("超出 renderer");
  });
});

describe("打包命令的构建顺序（模拟命令，不生成应用）", () => {
  async function executePackaging(failBuild: boolean) {
    const path = await fixture(false);
    const { readFile, chmod } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const bin = join(path, "test-bin");
    await mkdir(bin);
    const log = join(path, "sequence.txt");
    await writeFile(
      join(bin, "pnpm"),
      `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},'build\\n');process.exit(${failBuild ? 1 : 0});\n`,
    );
    await writeFile(
      join(bin, "electron-builder"),
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},'package\\n');\n`,
    );
    await chmod(join(bin, "pnpm"), 0o755);
    await chmod(join(bin, "electron-builder"), 0o755);
    const pkg = JSON.parse(
      await readFile(
        new URL("../apps/desktop/package.json", import.meta.url),
        "utf8",
      ),
    );
    let failed = false;
    try {
      await promisify(execFile)(
        "/bin/sh",
        ["-c", pkg.scripts["package:mac:dir"]],
        {
          cwd: path,
          env: { ...process.env, PATH: bin + ":" + process.env.PATH },
        },
      );
    } catch {
      failed = true;
    }
    return { failed, sequence: await readFile(log, "utf8") };
  }
  it("先完成生产构建才调用打包器", async () => {
    expect(await executePackaging(false)).toEqual({
      failed: false,
      sequence: "build\npackage\n",
    });
  });
  it("生产构建失败时不会继续打包旧文件", async () => {
    expect(await executePackaging(true)).toEqual({
      failed: true,
      sequence: "build\n",
    });
  });
});
