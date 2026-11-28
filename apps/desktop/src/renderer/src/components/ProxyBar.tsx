import { useCallback, useEffect, useState } from "react";
import { Activity, Play, Square, RefreshCw, ScrollText } from "lucide-react";
import type { RuntimeStatus } from "../../../main/local-runtime";
import type {
  SystemProxyStatus,
  NetworkService,
} from "../../../main/system-proxy";
import { useApp } from "../api";
import { Badge, Button, Modal, Select } from "./ui";
export default function ProxyBar({
  openSettings,
}: {
  openSettings: () => void;
}) {
  const { data, call, run } = useApp();
  const [status, setStatus] = useState<{
    runtime: RuntimeStatus;
    system: SystemProxyStatus;
  } | null>(null);
  const [services, setServices] = useState<NetworkService[]>([]);
  const [serviceId, setService] = useState("");
  const [choose, setChoose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState(false);
  const update = useCallback(
    async () => setStatus(await call("proxyStatus")),
    [call],
  );
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const next = await call<{
          runtime: RuntimeStatus;
          system: SystemProxyStatus;
        }>("proxyStatus");
        if (alive) setStatus(next);
      } catch {
        /* App feedback handles IPC errors. */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [call]);
  const active = data?.activeProxy;
  const subject =
    active?.kind === "chain"
      ? data?.chains.find((c) => c.id === active.id)
      : data?.nodes.find((n) => n.id === active?.id);
  const action = (name: string) => {
    setBusy(true);
    void run(async () => {
      try {
        await call("localProxyAction", { action: name, serviceId });
      } finally {
        await update();
      }
    }).finally(() => setBusy(false));
  };
  const network = () =>
    void run(async () => {
      const list = await call<NetworkService[]>("networkServices");
      setServices(list);
      const selected =
        list.find(
          (s) => s.id === data?.settings.networkServiceId && s.active,
        ) || list.find((s) => s.active);
      setService(selected?.id || "");
    });
  const running = status?.runtime.state === "running";
  const processing =
    busy || ["starting", "switching"].includes(status?.runtime.state || "");
  return (
    <footer
      className="proxy-bar border-t border-border bg-card"
      aria-label="本机代理控制栏"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Activity size={16} />
        <div className="min-w-0">
          <strong className="block truncate">
            {subject?.name || "尚未设置活动节点"}
          </strong>
          <small className="text-muted-foreground">
            本机 sing-box · {status?.runtime.state || "读取中"} · 127.0.0.1:
            {running
              ? status.runtime.port
              : data?.settings.localProxyPort || 10808}
          </small>
        </div>
      </div>
      <Badge
        tone={
          status?.system.conflict
            ? "bad"
            : status?.system.enabled
              ? "good"
              : "neutral"
        }
      >
        {status?.system.conflict
          ? "代理设置冲突"
          : status?.system.enabled
            ? "系统代理已开启"
            : status?.system.error
              ? "系统代理待授权 / 核验"
              : "未接管系统代理"}
      </Badge>
      <Button
        variant="ghost"
        size="icon"
        title="核心运行日志"
        onClick={() => setLogs(true)}
      >
        <ScrollText size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title={running ? "停止本机核心并恢复系统代理" : "启动本机核心"}
        disabled={processing || (!running && !subject)}
        onClick={() => action(running ? "stop" : "start")}
      >
        {running ? <Square size={15} /> : <Play size={15} />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="重启本机核心"
        disabled={processing || !running}
        onClick={() => action("restart")}
      >
        <RefreshCw size={15} />
      </Button>
      <Button
        variant={status?.system.enabled ? "secondary" : "default"}
        loading={busy}
        disabled={processing || (!status?.system.enabled && !subject)}
        onClick={() => {
          if (status?.system.conflict) openSettings();
          else if (status?.system.enabled) action("disableSystem");
          else {
            network();
            setChoose(true);
          }
        }}
      >
        {status?.system.conflict
          ? "处理代理冲突"
          : status?.system.enabled
            ? "关闭系统代理"
            : "开启系统代理"}
      </Button>
      {(status?.runtime.error || status?.system.error) && (
        <p role="alert" className="proxy-bar-error">
          {status.runtime.error || status.system.error}
        </p>
      )}
      <Modal
        open={logs}
        onClose={() => setLogs(false)}
        wide
        title="本机核心日志"
      >
        <pre className="output max-h-96 overflow-auto">
          {status?.runtime.logs.join("") || "暂无运行日志"}
        </pre>
        <p className="hint">
          日志仅保留本次应用会话的最近内容，节点凭据会被脱敏。
        </p>
      </Modal>
      <Modal
        open={choose}
        onClose={() => setChoose(false)}
        title="选择网络服务"
        description="只设置选中的活动网络服务，关闭后恢复此服务原来的 HTTP、HTTPS、SOCKS、PAC 和绕过列表。"
      >
        <Select
          aria-label="活动网络服务"
          value={serviceId}
          onValueChange={setService}
        >
          {services.map((s) => (
            <option key={s.id} value={s.id} disabled={!s.active}>
              {s.name}
              {s.active ? "（活动）" : "（非活动）"}
            </option>
          ))}
        </Select>
        <p className="hint py-3">
          首次使用请先在设置中安装并授权系统代理辅助程序。
        </p>
        <Button
          disabled={!serviceId || busy}
          onClick={() => {
            setChoose(false);
            action("enableSystem");
          }}
        >
          开启系统代理
        </Button>
      </Modal>
    </footer>
  );
}
