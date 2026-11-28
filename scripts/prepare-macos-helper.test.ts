import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
const require = createRequire(import.meta.url);
const prepare = require("./prepare-macos-helper.cjs") as (
  context: unknown,
  run: (file: string, args: string[]) => void,
) => Promise<void>;
const folders: string[] = [];
afterEach(() => {
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "gungun 原生打包-"));
  folders.push(path);
  const contents = join(path, "Gungun.app/Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  return {
    contents,
    context: {
      electronPlatformName: "darwin",
      appOutDir: path,
      packager: { appInfo: { productFilename: "Gungun" } },
    },
  };
}
describe("macOS 原生产物打包合同（模拟编译器，不冒充原生编译）", () => {
  it("编译主进程注册模块与 XPC 助手，plist 在主 Bundle 中；两份原生产物均纳入签名", async () => {
    const f = fixture();
    const calls: string[][] = [];
    await prepare(f.context, (file, args) => {
      expect(file).toBe("/usr/bin/xcrun");
      calls.push(args);
      writeFileSync(args[args.indexOf("-o") + 1], "simulated compiled binary");
    });
    expect(calls.map((args) => args[0])).toEqual(["swiftc", "clang++"]);
    expect(calls[1]).toContain("-DNAPI_VERSION=8");
    const pkg = JSON.parse(
      readFileSync(
        new URL("../apps/desktop/package.json", import.meta.url),
        "utf8",
      ),
    );
    for (const args of calls) {
      const output = args[args.indexOf("-o") + 1];
      expect(pkg.build.mac.binaries).toContain(
        "Contents/" + relative(f.contents, output),
      );
      expect(readFileSync(output, "utf8")).toBe("simulated compiled binary");
    }
    expect(
      readFileSync(
        join(f.contents, "Library/LaunchDaemons/io.gungun.proxy-helper.plist"),
        "utf8",
      ),
    ).toBe(
      readFileSync(
        new URL(
          "../native/macos/io.gungun.proxy-helper.plist",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  });
  it("编译失败阻断打包，不接受旧的注册模块", async () => {
    const f = fixture();
    await expect(
      prepare(f.context, () => {
        throw new Error("compiler error");
      }),
    ).rejects.toThrow("compiler error");
  });
  it("编译器未输出文件或输出空文件均阻断打包", async () => {
    const f = fixture();
    await expect(prepare(f.context, () => {})).rejects.toThrow();
    await expect(
      prepare(f.context, (_file, args) => {
        writeFileSync(args[args.indexOf("-o") + 1], "");
      }),
    ).rejects.toThrow("为空");
  });
  it("非 macOS 打包不调用原生编译器", async () => {
    await prepare({ electronPlatformName: "linux" }, () => {
      throw new Error("must not run");
    });
  });
});
