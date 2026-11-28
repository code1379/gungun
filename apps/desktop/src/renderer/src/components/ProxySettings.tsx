import { useEffect, useState } from "react";
import type { Settings } from "@gungun/domain";
import type { NetworkService } from "../../../main/system-proxy";
import { useApp } from "../api";
import { Button, Field, Input, Select } from "./ui";
export default function ProxySettings({
  values,
  update,
}: {
  values: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const { call, run } = useApp();
  const [services, setServices] = useState<NetworkService[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  useEffect(() => {
    void call<NetworkService[]>("networkServices")
      .then(setServices)
      .catch(() => {});
  }, [call]);
  const execute = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setResult("");
    void run(fn).finally(() => setBusy(false));
  };
  return (
    <section className="section settings-section">
      <h2>本机代理</h2>
      <p>
        使用 sing-box 1.14.4。系统代理复用同一个本机核心，支持 macOS 13 及以上。
      </p>
      <div className="form-grid">
        <Field
          label="本机 mixed 监听端口"
          hint="HTTP 和 SOCKS 共用 127.0.0.1；修改前请先停止本机核心。"
        >
          <Input
            type="number"
            min={1024}
            max={65535}
            value={values.localProxyPort}
            onChange={(e) => update("localProxyPort", Number(e.target.value))}
          />
        </Field>
        <Field label="首选网络服务">
          <Select
            value={values.networkServiceId}
            onValueChange={(id) => update("networkServiceId", id)}
          >
            <option value="">每次开启时选择活动服务</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.active ? "（活动）" : ""}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="toolbar wrap">
        <Button
          loading={busy}
          onClick={() =>
            execute(async () => {
              await call("downloadLocalCore");
              setResult("本机 sing-box 1.14.4 已通过版本检查");
            })
          }
        >
          下载 / 检查本机核心
        </Button>
        <Button
          loading={busy}
          onClick={() =>
            execute(async () => {
              const result = await call<{ status: string }>("authorizeProxy");
              setResult(
                result.status === "enabled"
                  ? "系统代理辅助程序已授权"
                  : result.status === "notFound"
                    ? "未找到随应用打包的 LaunchDaemon，请重新构建并安装 Gungun.app"
                    : "请在 macOS 系统设置 → 通用 → 登录项与扩展中允许 Gungun 后台辅助程序，然后重试",
              );
            })
          }
        >
          安装 / 授权系统代理辅助程序
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            execute(async () => setServices(await call("networkServices")))
          }
        >
          刷新网络服务
        </Button>
      </div>
      {result && (
        <p role="status" className="hint py-2">
          {result}
        </p>
      )}
      <p className="hint">
        系统代理需要已签名安装的
        Gungun.app。首次授权由系统处理，后续开关通过辅助程序复用授权，不保存管理员密码。
      </p>
      {services.map((s) => (
        <details key={s.id}>
          <summary>{s.name} 当前代理设置</summary>
          <p className="hint">服务 ID：{s.id}</p>
          <pre className="output">{JSON.stringify(s.proxies, null, 2)}</pre>
        </details>
      ))}
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => {
          if (
            window.confirm(
              "仅在你已核验并手动处理 macOS 网络代理设置后继续。此操作会放弃发生冲突的旧恢复记录，保留当前系统配置。确认？",
            )
          )
            execute(() => call("acknowledgeProxyConflict", true));
        }}
      >
        已手动处理冲突，解除旧恢复记录
      </Button>
    </section>
  );
}
