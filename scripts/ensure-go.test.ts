import { describe, expect, it } from "vitest";
import { findGoArchive, sha256Matches } from "./ensure-go.mjs";

const digest = "a".repeat(64);
describe("项目私有 Go 工具链", () => {
  it("选择固定版本、平台和带 SHA256 的官方归档", () => {
    const releases = [
      { version: "go1.25.3", files: [{ filename: "go1.25.3.darwin-arm64.tar.gz", kind: "archive", sha256: digest }] },
      { version: "go1.25.4", files: [
        { filename: "go1.25.4.darwin-arm64.tar.gz", kind: "archive", sha256: digest },
        { filename: "go1.25.4.darwin-amd64.tar.gz", kind: "archive", sha256: digest },
        { filename: "go1.25.4.darwin-arm64.pkg", kind: "package", sha256: digest },
      ] },
    ];
    expect(findGoArchive(releases)?.filename).toBe("go1.25.4.darwin-arm64.tar.gz");
    expect(findGoArchive(releases, "darwin", "amd64")?.filename).toBe("go1.25.4.darwin-amd64.tar.gz");
  });
  it("拒绝没有官方 SHA256 的归档", () => {
    expect(findGoArchive([{ version: "go1.25.4", files: [{ filename: "go1.25.4.darwin-arm64.tar.gz", kind: "archive" }] }])).toBeUndefined();
  });
  it("校验下载内容的 SHA256", () => {
    expect(sha256Matches(Buffer.from("gungun"), digest)).toBe(false);
    expect(sha256Matches(Buffer.from("gungun"), "invalid")).toBe(false);
  });
});
