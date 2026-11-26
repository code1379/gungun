import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
    void run(refresh);
    return window.gungun?.changed(() => {
      void refresh().catch((e) => setError(String(e)));
    });
  }, [refresh, run]);
  return (
    <AppContext.Provider
      value={{
        data,
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
