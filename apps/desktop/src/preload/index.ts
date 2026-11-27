import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("gungun", {
  invoke: (operation: string, input?: unknown) =>
    ipcRenderer.invoke("invoke", operation, input),
  changed: (callback: () => void) => {
    const fn = () => callback();
    ipcRenderer.on("changed", fn);
    return () => ipcRenderer.removeListener("changed", fn);
  },
  terminalOpen: () => ipcRenderer.invoke("terminal:open"),
  terminalInput: (data: string) => ipcRenderer.send("terminal:input", data),
  terminalResize: (size: { cols: number; rows: number }) =>
    ipcRenderer.send("terminal:resize", size),
  terminalData: (callback: (data: string) => void) => {
    const fn = (_event: unknown, data: string) => callback(data);
    ipcRenderer.on("terminal:data", fn);
    return () => ipcRenderer.removeListener("terminal:data", fn);
  },
});
