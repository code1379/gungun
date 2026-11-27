import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Snapshot } from "@gungun/domain";
declare global {
  interface Window {
    gungun: {
      invoke: (
        operation: string,
        input?: unknown,
      ) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
      changed: (callback: () => void) => () => void;
      terminalOpen: () => Promise<boolean>;
      terminalInput: (data: string) => void;
      terminalResize: (size: { cols: number; rows: number }) => void;
      terminalData: (callback: (data: string) => void) => () => void;
    };
  }
}
export async function invoke<T>(op: string, input?: unknown): Promise<T> {
  if (!window.gungun) throw new Error("请通过 Gungun 桌面应用打开");
  const r = await window.gungun.invoke(op, input);
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
}
interface Context {
  resolvedTheme: "light" | "dark";
  data: Snapshot | null;
  refresh: () => Promise<void>;
  call: typeof invoke;
  run: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  message: string;
  error: string;
  clear: () => void;
}
const AppContext = createContext<Context | null>(null);
export function Provider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const previousTaskStates = useRef<Record<string, string>>({});
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const preference = data?.settings.theme || "system";
  const resolvedTheme =
    preference === "system" ? (systemDark ? "dark" : "light") : preference;
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);
  const refresh = useCallback(async () => {
    setData(await invoke<Snapshot>("snapshot"));
  }, []);
  const run = useCallback(
    async (fn: () => Promise<unknown>, success = "") => {
      setError("");
      setMessage("");
      try {
        await fn();
        await refresh();
        setMessage(success);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const task of data.tasks) {
      const previous = previousTaskStates.current[task.id];
      const finished = ["success", "failed", "interrupted"].includes(task.state);
      if (previous && ["queued", "running"].includes(previous) && finished) {
        if (task.state === "failed" || task.state === "interrupted") {
          setMessage("");
          setError(`${task.type}${task.state === "failed" ? "失败" : "已中断"}：${(task.error || "任务未能完成").slice(-1200)}`);
        } else {
          setError("");
          setMessage(`${task.type} 已完成`);
        }
      }
      next[task.id] = task.state;
    }
    previousTaskStates.current = next;
  }, [data?.tasks]);

  useEffect(() => {
    void run(refresh);
    return window.gungun?.changed(() => {
      void refresh().catch((e) => setError(String(e)));
    });
  }, [refresh, run]);
  return (
    <AppContext.Provider
      value={{
        data,
        resolvedTheme,
        refresh,
        call: invoke,
        run,
        message,
        error,
        clear: () => {
          setError("");
          setMessage("");
        },
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("App provider missing");
  return ctx;
}
export function errorText(error: string) {
  try {
    const start = error.indexOf("{");
    const obj = JSON.parse(error.slice(start, error.lastIndexOf("}") + 1)) as {
      code: string;
      message: string;
    };
    if (obj.code.startsWith("HOST_KEY")) return obj.message;
  } catch {
    /* 普通错误 */
  }
  return error;
}
