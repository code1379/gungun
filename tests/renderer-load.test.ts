import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { loadRenderer } from "../apps/desktop/src/main/renderer-load";
function fixture() {
  return {
    loadURL: vi.fn(async (_url: string) => {}),
    loadFile: vi.fn(
      async (_path: string, _options: { query: Record<string, string> }) => {},
    ),
  };
}
const directory = join(
  "/Applications/有空格 Gungun.app",
  "Contents/Resources/app.asar/out/main",
);
describe("开发 / 打包窗口加载路径", () => {
  it("打包应用忽略遗留开发 URL，只加载随包 HTML", async () => {
    const window = fixture();
    await loadRenderer(window, {
      packaged: true,
      mainDirectory: directory,
      developmentURL: "http://localhost:5173",
      type: "main",
      id: "",
    });
    expect(window.loadURL).not.toHaveBeenCalled();
    expect(window.loadFile).toHaveBeenCalledWith(
      join(directory, "../renderer/index.html"),
      { query: { view: "main", id: "" } },
    );
  });
  it("开发服务器保留已有查询参数并编码工作窗口 ID", async () => {
    const window = fixture();
    await loadRenderer(window, {
      packaged: false,
      mainDirectory: directory,
      developmentURL: "http://localhost:5173/?dev=1",
      type: "logs",
      id: "id with &",
    });
    const url = new URL(window.loadURL.mock.calls[0][0]);
    expect(url.searchParams.get("dev")).toBe("1");
    expect(url.searchParams.get("view")).toBe("logs");
    expect(url.searchParams.get("id")).toBe("id with &");
    expect(window.loadFile).not.toHaveBeenCalled();
  });
  it("没有开发 URL 时可从生产文件预览，加载失败向主进程传播", async () => {
    const window = fixture();
    window.loadFile.mockRejectedValueOnce(new Error("ERR_FILE_NOT_FOUND"));
    await expect(
      loadRenderer(window, {
        packaged: false,
        mainDirectory: directory,
        type: "main",
        id: "",
      }),
    ).rejects.toThrow("ERR_FILE_NOT_FOUND");
  });
});
