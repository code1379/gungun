import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientChannel } from "ssh2";
import type { VPS } from "@gungun/domain";
import { Store } from "./store";
import { API } from "./api";
import { z } from "zod";
const here = fileURLToPath(new URL(".", import.meta.url));
let store: Store;
let api: API;
const sessions = new Map<
  number,
  { stream: ClientChannel; close: () => void }
>();
const windows = new Map<number, { type: string; id: string }>();
function notify() {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send("changed");
}
function openWindow(type = "main", id = "") {
  const win = new BrowserWindow({
    width: type === "main" ? 1280 : 1000,
    height: 820,
    minWidth: type === "main" ? 980 : 600,
    minHeight: 620,
    title: "Gungun",
    backgroundColor: "#17191c",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 19 },
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contentsId = win.webContents.id;
  windows.set(contentsId, { type, id });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("closed", () => {
    const session = sessions.get(contentsId);
    session?.close();
    sessions.delete(contentsId);
    windows.delete(contentsId);
  });
  const query = { view: type, id };
  if (process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(
      `${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query)}`,
    );
  else void win.loadFile(join(here, "../renderer/index.html"), { query });
  return win;
}
function trusted(event: IpcMainInvokeEvent) {
  if (
    event.senderFrame !== event.sender.mainFrame ||
    !windows.has(event.sender.id)
  )
    throw new Error("无效 IPC 来源");
}
app.setName("Gungun");
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
  });
  void app.whenReady().then(() => {
    const data = process.env.GUNGUN_DATA_DIR || app.getPath("userData");
    store = new Store(join(data, "gungun.db"));
    const resources = app.isPackaged
      ? join(process.resourcesPath, "bin")
      : join(app.getAppPath(), "../../resources/bin");
    api = new API(store, notify, resources, data, openWindow);
    ipcMain.handle("invoke", async (event, op: unknown, input: unknown) => {
      trusted(event);
      const operation = z.string().max(64).parse(op);
      const role = windows.get(event.sender.id)!;
      if (
        role.type !== "main" &&
        !["snapshot", "remoteRead", "trustHost"].includes(operation)
      )
        throw new Error("该工作窗口不允许此操作");
      if (role.type !== "main" && operation === "trustHost") {
        const q = z.object({ address: z.string() }).passthrough().parse(input);
        let current =
          role.type === "task"
            ? store.get<{ vpsId: string | null }>("tasks", role.id).vpsId
            : role.id;
        const allowed = new Set<string>();
        while (current) {
          const v = store.get<VPS>("vps", current);
          allowed.add(`${v.address}:${v.sshPort}`);
          current = v.jumpId;
        }
        if (!allowed.has(q.address)) throw new Error("工作窗口主机不匹配");
      }
      if (
        role.type === "logs" &&
        operation === "remoteRead" &&
        (!input ||
          typeof input !== "object" ||
          !("vpsId" in input) ||
          input.vpsId !== role.id)
      )
        throw new Error("工作窗口 VPS 不匹配");
      try {
        return { ok: true, value: await api.invoke(operation, input) };
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) };
      }
    });
    ipcMain.handle("terminal:open", async (event) => {
      trusted(event);
      const role = windows.get(event.sender.id);
      if (role?.type !== "terminal") throw new Error("不是终端窗口");
      sessions.get(event.sender.id)?.close();
      const vps = store.get<VPS>("vps", role.id);
      const connection = await api.ssh.connect(vps);
      try {
        const stream = await new Promise<ClientChannel>((resolve, reject) =>
          connection.client.shell(
            { term: "xterm-256color", cols: 100, rows: 30 },
            (e, s) => (e ? reject(e) : resolve(s)),
          ),
        );
        sessions.set(event.sender.id, {
          stream,
          close: () => {
            stream.close();
            connection.close();
          },
        });
        stream.on(
          "data",
          (b: Buffer) =>
            !event.sender.isDestroyed() &&
            event.sender.send("terminal:data", b.toString()),
        );
        stream.stderr.on(
          "data",
          (b: Buffer) =>
            !event.sender.isDestroyed() &&
            event.sender.send("terminal:data", b.toString()),
        );
        stream.on("close", () => {
          connection.close();
          if (!event.sender.isDestroyed())
            event.sender.send("terminal:data", "\r\n[SSH 连接已关闭]\r\n");
        });
        return true;
      } catch (e) {
        connection.close();
        throw e;
      }
    });
    ipcMain.on("terminal:input", (event, data: unknown) => {
      const role = windows.get(event.sender.id);
      if (
        event.senderFrame !== event.sender.mainFrame ||
        role?.type !== "terminal"
      )
        return;
      const parsed = z.string().max(65536).safeParse(data);
      if (parsed.success)
        sessions.get(event.sender.id)?.stream.write(parsed.data);
    });
    ipcMain.on("terminal:resize", (event, size: unknown) => {
      if (
        event.senderFrame !== event.sender.mainFrame ||
        windows.get(event.sender.id)?.type !== "terminal"
      )
        return;
      const parsed = z
        .object({
          cols: z.number().int().min(10).max(1000),
          rows: z.number().int().min(2).max(1000),
        })
        .safeParse(size);
      if (parsed.success)
        sessions
          .get(event.sender.id)
          ?.stream.setWindow(parsed.data.rows, parsed.data.cols, 0, 0);
    });
    openWindow();
    setTimeout(() => {
      void api.renewDue();
    }, 10000).unref();
    setInterval(
      () => {
        void api.renewDue();
      },
      24 * 60 * 60 * 1000,
    ).unref();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) openWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    for (const s of sessions.values()) s.close();
    store?.close();
  });
}
