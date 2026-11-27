import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useApp } from "../api";
import { terminalTheme } from "../lib/theme";
import {
  Badge,
  Button,
  ErrorView,
  pretty,
  Select,
  Progress,
} from "../components/ui";
export default function WorkWindow({ type, id }: { type: string; id: string }) {
  const { data, call, resolvedTheme } = useApp();
  const xterm = useRef<Terminal | null>(null);
  useEffect(() => {
    if (xterm.current)
      xterm.current.options.theme = terminalTheme(resolvedTheme);
  }, [resolvedTheme]);
  const terminalRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [log, setLog] = useState("");
  const [unit, setUnit] = useState("gungun-sing-box");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (type !== "terminal" || !terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, monospace",
      theme: terminalTheme(
        document.documentElement.classList.contains("dark") ? "dark" : "light",
      ),
    });
    xterm.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalRef.current);
    fit.fit();
    const data = terminal.onData((text) => window.gungun.terminalInput(text));
    const remove = window.gungun.terminalData((text) => terminal.write(text));
    let disposed = false;
    const resize = () => {
      fit.fit();
      window.gungun.terminalResize({
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(terminalRef.current);
    void window.gungun
      .terminalOpen()
      .then(() => {
        if (!disposed) resize();
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      observer.disconnect();
      remove();
      data.dispose();
      terminal.dispose();
      xterm.current = null;
    };
  }, [type, id, retry]);
  useEffect(() => {
    if (type !== "logs") return;
    let disposed = false;
    let active = false;
    const load = async () => {
      if (active) return;
      active = true;
      try {
        const result = await call<{ log: string }>("remoteRead", {
          vpsId: id,
          action: "log",
          unit,
        });
        if (!disposed) {
          setLog(result.log);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        active = false;
      }
    };
    void load();
    const interval = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [type, id, unit, call]);
  const task = data?.tasks.find((t) => t.id === id);
  return (
    <div className="work-window">
      <header className="work-title">
        <strong>
          {type === "terminal"
            ? "SSH 终端"
            : type === "logs"
              ? "实时日志"
              : "任务详情"}
        </strong>
        <span className="muted">
          {data?.vps.find((v) => v.id === id || v.id === task?.vpsId)?.name ||
            task?.type}
        </span>
        <span className="grow" />
        {type === "logs" && (
          <Select
            className="inline-select"
            value={unit}
            onValueChange={(value) => setUnit(value)}
          >
            <option value="gungun-sing-box">sing-box</option>
            <option value="gungun-caddy">Caddy</option>
            <option value="gungun-tunnel">Tunnel</option>
          </Select>
        )}
        {type === "terminal" && (
          <Button onClick={() => setRetry((r) => r + 1)}>重新连接</Button>
        )}
      </header>
      {error && <ErrorView error={error} />}
      <div
        ref={terminalRef}
        className={type === "terminal" ? "terminal-container" : "hidden"}
      />
      {type === "logs" && (
        <pre className="log-output">{log || "正在读取日志…"}</pre>
      )}
      {type === "task" && task && (
        <section className="section">
          <div className="section-heading">
            <h1>{task.type}</h1>
            <Badge>{task.state}</Badge>
          </div>
          <Progress value={task.progress} max={100} />
          {task.steps.map((s, i) => (
            <div className="task-step" key={i}>
              <Badge
                tone={
                  s.state === "failed"
                    ? "bad"
                    : s.state === "success"
                      ? "good"
                      : "blue"
                }
              >
                {s.state}
              </Badge>
              <span>{s.name}</span>
              {s.message && <p>{s.message}</p>}
            </div>
          ))}
          {task.error && <ErrorView error={task.error} />}
          {task.output !== undefined && (
            <pre className="output">{pretty(task.output)}</pre>
          )}
        </section>
      )}
    </div>
  );
}
