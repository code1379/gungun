import { useEffect, useRef, useState } from "react";
import { Rocket, Server, Shield, Network, LoaderCircle, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import { RemoteState, Service, VPS } from "@gungun/domain";
import { useApp } from "../api";
import { Badge, Button, Empty, Field, PageHeader, protocolLabels, Select, Input } from "../components/ui";
interface Zone { id: string; name: string; account: { id: string; name: string } }
const defaults: Service = {
  id: "hysteria2",
  protocol: "hysteria2",
  port: 0,
  publicPort: 0,
  edgePort: 443,
  access: "direct",
  egress: "DIRECT",
  domain: "",
  password: "",
  uuid: "",
  path: "/gungun",
  realityServer: "www.microsoft.com",
  realityPort: 443,
};
export default function Deploy() {
  const { data, call, run } = useApp();
  const [vpsId, setVpsId] = useState("");
  const [service, setService] = useState<Service>(defaults);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [zoneId, setZoneId] = useState("");
  const [zoneStatus, setZoneStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [zoneMessage, setZoneMessage] = useState("");
  const [remoteStatus, setRemoteStatus] = useState<"idle" | "loading" | "ready" | "missing-fq" | "error">("idle");
  const [remoteError, setRemoteError] = useState("");
  const [installingFq, setInstallingFq] = useState(false);
  const [installTaskId, setInstallTaskId] = useState<string | null>(null);
  const [bindingZone, setBindingZone] = useState(false);
  const [deploying, setDeploying] = useState(false);
  if (!data) return null;
  const vps = data.vps.find((v) => v.id === vpsId);
  const selectedZone = zones.find((zone) => zone.id === zoneId);
  const activeZoneName = selectedZone?.name || vps?.zoneName || "";
  const domainPrefix = service.access === "cdn" ? "cdn" : service.access === "argo" ? "argo" : "node";
  const generatedDomain = activeZoneName && vps
    ? `${domainPrefix}.${vps.namespace}.${activeZoneName}`
    : "";
  const update = <K extends keyof Service>(key: K, value: Service[K]) =>
    setService((prev) => ({ ...prev, [key]: value }));
  const readRemote = (id: string) => {
    setRemote(null);
    setRemoteError("");
    setRemoteStatus("loading");
    void run(async () => {
      try {
        const state = await call<RemoteState>("remoteRead", { vpsId: id, action: "config" });
        setRemote(state);
        setRemoteStatus("ready");
      } catch (error) {
        const message = String(error);
        if (/\/usr\/local\/bin\/fq: not found|fq: not found/.test(message)) {
          setRemoteStatus("missing-fq");
          return;
        }
        setRemoteError(message);
        setRemoteStatus("error");
      }
    });
  };
  const selectHost = (id: string) => {
    const host = data.vps.find((v) => v.id === id);
    setVpsId(id);
    setZoneId(host?.zoneId || "");
    setZoneStatus(host?.zoneId ? "success" : "idle");
    setZoneMessage(host?.zoneName ? `当前绑定：${host.zoneName}` : "");
    readRemote(id);
  };
  const readZones = async () => {
    setZoneStatus("loading");
    setZoneMessage("正在读取 Cloudflare Zone…");
    try {
      const result = await call<Zone[]>("zones");
      setZones(result);
      setZoneStatus("success");
      setZoneMessage(`已读取 ${result.length} 个域名`);
    } catch (error) {
      setZoneStatus("error");
      setZoneMessage("读取失败");
      throw error;
    }
  };
  const bindSelectedZone = () => {
    if (!vps || !selectedZone) return;
    void run(async () => {
      setBindingZone(true);
      try {
        await call("saveVps", {
          ...vps,
          zoneId: selectedZone.id,
          zoneName: selectedZone.name,
          accountId: selectedZone.account.id,
        });
        setZoneStatus("success");
        setZoneMessage(`已绑定到此 VPS：${selectedZone.name}`);
      } finally {
        setBindingZone(false);
      }
    }, "Cloudflare Zone 已绑定到 VPS");
  };

  useEffect(() => {
    if (!data || !installTaskId) return;
    const task = data.tasks.find((item) => item.id === installTaskId);
    if (!task || ["queued", "running"].includes(task.state)) return;
    setInstallingFq(false);
    setInstallTaskId(null);
    if (task.state !== "success" || task.vpsId !== vpsId) return;
    setRemote(null);
    setRemoteError("");
    setRemoteStatus("loading");
    void call<RemoteState>("remoteRead", { vpsId, action: "config" })
      .then((state) => {
        setRemote(state);
        setRemoteStatus("ready");
      })
      .catch((error) => {
        const message = String(error);
        if (/\\/usr\\/local\\/bin\\/fq: not found|fq: not found/.test(message)) {
          setRemoteStatus("missing-fq");
          return;
        }
        setRemoteError(message);
        setRemoteStatus("error");
      });
  }, [data?.tasks, installTaskId, vpsId, call]);
  return (
    <>
      <PageHeader
        title="部署中心"
        description="逐个添加协议，已有协议与远程配置保持完整。"
      />
      {data.vps.length ? (
        <div className="deploy-layout">
          <aside className="deploy-hosts">
            <h2>选择目标主机</h2>
            <div className="deploy-hosts-list">
            {data.vps.map((v) => (
              <button
                key={v.id}
                className={`deploy-host ${vpsId === v.id ? "active" : ""}`}
                aria-pressed={vpsId === v.id}
                onClick={() => selectHost(v.id)}
              >
                {vpsId === v.id && remoteStatus === "loading"
                  ? <LoaderCircle className="animate-spin" size={18} />
                  : <Server size={18} />}
                <span>
                  {v.name}
                  <small>{v.kind === "nat" ? "NAT VPS" : "公网 VPS"}</small>
                </span>
              </button>
            ))}
            </div>
          </aside>
          <section className="deploy-form">
            {vps && (
              <section className="zone-binding-panel">
                <div className="section-heading">
                  <div>
                    <h2>域名与 Cloudflare</h2>
                    <p>在这里为这台 VPS 绑定域名区域；不依赖 fq 是否安装。</p>
                  </div>
                  <Badge tone={vps.zoneId ? "good" : "neutral"}>
                    {vps.zoneId ? "已绑定" : "尚未绑定"}
                  </Badge>
                </div>
                <div className="zone-binding-controls">
                  <Select value={zoneId} onValueChange={(value) => {
                    setZoneId(value);
                    const zone = zones.find((item) => item.id === value);
                    setZoneStatus(value ? "success" : "idle");
                    setZoneMessage(zone ? `已选择：${zone.name}，点击「绑定到 VPS」保存` : "");
                  }}>
                    <option value="">选择 Cloudflare Zone</option>
                    {vps.zoneId && !zones.some((zone) => zone.id === vps.zoneId) && (
                      <option value={vps.zoneId}>{vps.zoneName || vps.zoneId}</option>
                    )}
                    {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
                  </Select>
                  <Button type="button" loading={zoneStatus === "loading"} disabled={zoneStatus === "loading"} onClick={() => {
                    void run(readZones, "Cloudflare Zone 读取成功");
                  }}>
                    <RefreshCw size={14} />
                    读取 Zone
                  </Button>
                  <Button type="button" variant="default" loading={bindingZone} disabled={!selectedZone || bindingZone} onClick={bindSelectedZone}>
                    绑定到 VPS
                  </Button>
                </div>
                <p className="zone-binding-meta">
                  独立域名空间：<code>{vps.namespace}</code>
                  {vps.zoneName ? <span>当前域名区域：{vps.zoneName}</span> : <span>绑定后可自动生成 node.{vps.namespace}.域名</span>}
                </p>
                {zoneStatus !== "idle" && (
                  <div className={`zone-read-status ${zoneStatus}`}>
                    {zoneStatus === "loading" ? <LoaderCircle className="animate-spin" size={13} /> : zoneStatus === "error" ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
                    <span>{zoneMessage}</span>
                  </div>
                )}
              </section>
            )}
            {vps && remoteStatus === "missing-fq" ? (
              <Empty
                title="这台 VPS 尚未安装 fq"
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button
                      loading={installingFq}
                      disabled={installingFq}
                      onClick={() => {
                        void run(async () => {
                          const taskId = await call<string>("installFq", vps.id);
                          setInstallTaskId(taskId);
                          setInstallingFq(true);
                        }, "fq 安装任务已加入任务中心");
                      }}
                    >
                      {installingFq ? "正在加入任务…" : "安装 fq"}
                    </Button>
                    <Button variant="outline" loading={remoteStatus === "loading"} disabled={remoteStatus === "loading"} onClick={() => readRemote(vps.id)}>
                      重新读取
                    </Button>
                  </div>
                }
              >
                部署中心需要通过 SSH 调用 VPS 上的 fq。先安装 fq，完成后重新读取远程配置。
              </Empty>
            ) : vps && remoteStatus === "loading" ? (
              <Empty title="正在读取 VPS 配置">
                正在通过 SSH 读取这台 VPS 的协议和远程服务状态…
              </Empty>
            ) : vps && remoteStatus === "error" ? (
              <Empty
                title="读取 VPS 配置失败"
                action={<Button loading={remoteStatus === "loading"} disabled={remoteStatus === "loading"} onClick={() => readRemote(vps.id)}>重试</Button>}
              >
                {remoteError}
              </Empty>
            ) : vps && remoteStatus === "ready" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    setDeploying(true);
                    try {
                    const needsZone = service.access !== "direct" || !!service.domain.trim();
                    if (needsZone && !vps.zoneName && !selectedZone)
                      throw new Error("当前接入方式需要域名，请先在上方绑定 Cloudflare Zone");
                    if (selectedZone && selectedZone.id !== vps.zoneId) {
                      await call("saveVps", {
                        ...vps,
                        zoneId: selectedZone.id,
                        zoneName: selectedZone.name,
                        accountId: selectedZone.account.id,
                      });
                    }
                    await call("deploy", { vpsId: vps.id, service });
                    } finally {
                      setDeploying(false);
                    }
                  }, "部署任务已加入队列，请在任务中心查看执行与回滚结果");
                }}
              >
                <div className="section-heading">
                  <h2>部署协议服务</h2>
                  <Badge tone="blue">sing-box</Badge>
                </div>
                <div className="protocol-grid">
                  {Object.entries(protocolLabels).map(([id, label]) => (
                    <button
                      type="button"
                      key={id}
                      className={`protocol-choice ${service.protocol === id ? "active" : ""}`}
                      onClick={() => {
                        const existing = remote?.services.find(
                          (s) => s.protocol === id,
                        );
                        setService(
                          existing || {
                            ...defaults,
                            id,
                            protocol: id as Service["protocol"],
                            access: "direct",
                          },
                        );
                      }}
                    >
                      <Network size={19} />
                      <span>{label}</span>
                      {remote?.services.some((s) => s.protocol === id) && (
                        <Badge tone="good">已部署</Badge>
                      )}
                    </button>
                  ))}
                </div>
                <div className="form-grid">

                  <Field label="接入方式">
                    <Select
                      value={service.access}
                      onValueChange={(value) =>
                        update("access", value as Service["access"])}
                    >
                      <option value="direct">直连</option>
                      {service.protocol === "vless-ws" && (
                        <>
                          <option value="cdn">Cloudflare CDN</option>
                          <option value="argo">Argo Tunnel</option>
                        </>
                      )}
                    </Select>
                  </Field>
                  <Field label="协议出站">
                    <Select
                      value={service.egress}
                      onValueChange={(value) =>
                        update("egress", value as Service["egress"])}
                    >
                      <option value="DIRECT">DIRECT</option>
                      <option value="WARP">WARP</option>
                    </Select>
                  </Field>
                  <Field
                    label="内部监听端口"
                    hint={
                      vps.kind === "nat"
                        ? "NAT 主机必须填写内部端口。"
                        : "0 表示自动分配可用端口。"
                    }
                  >
                    <Input
                      type="number"
                      min={vps.kind === "nat" ? 1 : 0}
                      max={65535}
                      required
                      value={service.port}
                      onChange={(e) => update("port", Number(e.target.value))}
                    />
                  </Field>
                  {service.access !== "argo" && (
                    <Field
                      label="公网回源 / 映射端口"
                      hint={
                        vps.kind === "nat"
                          ? "填写服务商已分配的公网映射端口。"
                          : "0 表示与内部监听端口相同。"
                      }
                    >
                      <Input
                        type="number"
                        required
                        min={vps.kind === "nat" ? 1 : 0}
                        max={65535}
                        value={service.publicPort}
                        onChange={(e) =>
                          update("publicPort", Number(e.target.value))
                        }
                      />
                    </Field>
                  )}
                  {service.access === "cdn" && (
                    <Field label="Cloudflare Edge HTTPS 端口">
                      <Select
                        value={service.edgePort}
                        onValueChange={(value) =>
                          update("edgePort", Number(value))}
                      >
                        {[443, 2053, 2083, 2087, 2096, 8443].map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {service.protocol !== "vless-reality" && (
                    <Field
                      label="域名（可选）"
                      hint={
                        service.domain
                          ? "使用你填写的自定义域名；必须属于当前选择的 Cloudflare Zone。"
                          : generatedDomain
                            ? `留空自动生成：${generatedDomain}`
                            : service.access === "direct"
                              ? "可留空；如果需要 DNS 和证书，可先选择 Cloudflare Zone。"
                              : "先在上方选择 Cloudflare Zone；域名无需手动填写，留空即可自动生成。"
                      }
                    >
                      <Input
                        value={service.domain}
                        onChange={(e) => update("domain", e.target.value)}
                        placeholder={generatedDomain || "留空自动生成域名"}
                      />
                    </Field>
                  )}
                  {service.protocol === "vless-ws" && (
                    <Field label="WebSocket 路径">
                      <Input
                        required
                        value={service.path}
                        onChange={(e) => update("path", e.target.value)}
                      />
                    </Field>
                  )}
                  {service.protocol === "vless-reality" && (
                    <>
                      <Field label="Reality 握手目标">
                        <Input
                          required
                          value={service.realityServer}
                          onChange={(e) =>
                            update("realityServer", e.target.value)
                          }
                        />
                      </Field>
                      <Field label="Reality 握手端口">
                        <Input
                          type="number"
                          min={1}
                          max={65535}
                          value={service.realityPort}
                          onChange={(e) =>
                            update("realityPort", Number(e.target.value))
                          }
                        />
                      </Field>
                    </>
                  )}
                  <Field
                    label={service.protocol === "snell" ? "PSK" : "密码"}
                    hint="留空由 fq 生成随机凭据。"
                  >
                    <Input
                      type="password"
                      autoComplete="off"
                      value={service.password}
                      onChange={(e) => update("password", e.target.value)}
                    />
                  </Field>
                  {["tuic", "vless-ws", "vless-reality"].includes(
                    service.protocol,
                  ) && (
                    <Field label="UUID" hint="留空自动生成。">
                      <Input
                        value={service.uuid}
                        onChange={(e) => update("uuid", e.target.value)}
                      />
                    </Field>
                  )}
                </div>
                {service.access === "argo" && (
                  <p className="info-note">
                    <Network size={17} />
                    复用此 VPS 的固定 Tunnel，生成 443 TLS 和 80 HTTP
                    两个客户端节点。VPS 无需开放 80 / 443 入站。
                  </p>
                )}
                {service.egress === "WARP" && (
                  <p className="info-note">
                    <Shield size={17} />
                    请先在网络服务中安装并连接
                    WARP。此选项只改变当前协议的出站。
                  </p>
                )}
                <div className="form-actions">
                  <Button type="submit" variant="default" loading={deploying} disabled={deploying}>
                    <Rocket size={16} />
                    {deploying ? "正在提交部署…" : `部署到 ${vps.name}`}
                  </Button>
                </div>
              </form>
            ) : (
              <Empty title="选择一台 VPS">
                读取该 VPS 的真实配置后选择协议；首次使用请先在 VPS 详情安装
                fq。
              </Empty>
            )}
          </section>
        </div>
      ) : (
        <Empty title="先添加一台 VPS">
          在 VPS 管理中添加连接，并安装 fq 与 sing-box。
        </Empty>
      )}
    </>
  );
}
export function hostLabel(v: VPS) {
  return `${v.name} (${v.address})`;
}

