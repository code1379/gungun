import { useEffect, useRef, useState } from "react";
import { Rocket, Server, Shield, Network, LoaderCircle, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import { RemoteState, Service, VPS } from "@gungun/domain";
import { useApp } from "../api";
import { Badge, Button, Empty, Field, PageHeader, protocolLabels, Select, Input, Checkbox } from "../components/ui";
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
type ServicePortConfig = { port: number; publicPort: number; separatePublicPort: boolean };
function transportForProtocol(protocol: Service["protocol"]): "tcp" | "udp" {
  return protocol === "hysteria2" || protocol === "tuic" ? "udp" : "tcp";
}
function portKey(transport: "tcp" | "udp", port: number) {
  return `${transport}:${port}`;
}
const protocolIds = Object.keys(protocolLabels) as Service["protocol"][];
const protocolDescriptions: Record<Service["protocol"], string> = {
  hysteria2: "Hysteria2 使用独立密码和 TLS 证书，适合 UDP 高性能传输。",
  tuic: "TUIC 使用 UUID、密码和 H3 ALPN。",
  anytls: "AnyTLS 使用独立密码和 TLS 证书。",
  snell: "Snell v6 使用 PSK，不需要 Cloudflare 域名或 TLS 证书。",
  "vless-ws": "VLESS + WebSocket 可同时启用直连、Cloudflare CDN 和 Argo Tunnel。",
  "vless-reality": "VLESS + Reality 使用 UUID 和握手目标，不依赖 Cloudflare 域名。",
};
const protocolDomainPrefix: Record<Service["protocol"], string> = { hysteria2: "hy2", tuic: "tuic", anytls: "anytls", snell: "snell", "vless-ws": "vless-ws", "vless-reality": "reality" };
function createServiceConfig(protocol: Service["protocol"]): Service { return { ...defaults, id: protocol, protocol }; }
function createServiceConfigMap(): Record<Service["protocol"], Service> {
  return Object.fromEntries(protocolIds.map((protocol) => [protocol, createServiceConfig(protocol)])) as Record<Service["protocol"], Service>;
}
function readServiceSelections(state: RemoteState) {
  const configs = createServiceConfigMap();
  for (const protocol of protocolIds) {
    const matches = state.services.filter((item) => item.protocol === protocol);
    const preferred = matches.find((item) => item.access === "direct") || matches.find((item) => item.access === "cdn") || matches[0];
    if (preferred) configs[protocol] = { ...configs[protocol], ...preferred };
  }
  const modes = state.services.filter((item) => item.protocol === "vless-ws").map((item) => item.access);
  return {
    configs,
    protocols: [...new Set(state.services.map((item) => item.protocol))],
    accessModes: modes.length ? [...new Set(modes)] : ["direct" as const],
    customDomains: Object.fromEntries(state.services.map((item) => [[item.protocol, item.access].join(":"), item.domain])) as Record<string, string>,
    portAssignments: Object.fromEntries(state.services.map((item) => [[item.protocol, item.access].join(":"), { port: item.port, publicPort: item.publicPort, separatePublicPort: item.publicPort > 0 && item.publicPort !== item.port }])) as Record<string, ServicePortConfig>,
  };
}
export default function Deploy() {
  const { data, call, run } = useApp();
  const [vpsId, setVpsId] = useState("");
  const [serviceConfigs, setServiceConfigs] = useState<Record<Service["protocol"], Service>>(() => createServiceConfigMap());
  const [portAssignments, setPortAssignments] = useState<Record<string, ServicePortConfig>>({});
  const [selectedProtocols, setSelectedProtocols] = useState<Service["protocol"][]>(["hysteria2"]);
  const [accessModes, setAccessModes] = useState<Service["access"][]>(["direct"]);
  const [customDomains, setCustomDomains] = useState<Record<string, string>>({});
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
        const selections = readServiceSelections(state);
        setServiceConfigs(selections.configs);
        if (selections.protocols.length) setSelectedProtocols(selections.protocols);
        setAccessModes(selections.accessModes);
        setCustomDomains(selections.customDomains);
        setPortAssignments(selections.portAssignments);
      })
      .catch((error) => {
        const message = String(error);
        if (message.includes("/usr/local/bin/fq: not found") || message.includes("fq: not found")) {
          setRemoteStatus("missing-fq");
          return;
        }
        setRemoteError(message);
        setRemoteStatus("error");
      });
  }, [data?.tasks, installTaskId, vpsId, call]);
  if (!data) return null;
  const vps = data.vps.find((v) => v.id === vpsId);
  const selectedZone = zones.find((zone) => zone.id === zoneId);
  const updateService = <K extends keyof Service,>(protocol: Service["protocol"], key: K, value: Service[K]) =>
    setServiceConfigs((current) => ({ ...current, [protocol]: { ...current[protocol], [key]: value } }));
  const updatePort = (protocol: Service["protocol"], access: Service["access"], key: keyof ServicePortConfig, value: number) => {
    const id = [protocol, access].join(":");
    setPortAssignments((current) => ({
      ...current,
      [id]: { port: 0, publicPort: 0, separatePublicPort: false, ...current[id], [key]: value },
    }));
  };
  const selectedCombinations = selectedProtocols.flatMap((protocol) =>
    (protocol === "vless-ws" ? accessModes : ["direct" as const]).map((access) => ({ protocol, access })),
  );
  const readRemote = (id: string) => {
    setRemote(null);
    setRemoteError("");
    setRemoteStatus("loading");
    void run(async () => {
      try {
        const state = await call<RemoteState>("remoteRead", { vpsId: id, action: "config" });
        setRemote(state);
        setRemoteStatus("ready");
        const selections = readServiceSelections(state);
        setServiceConfigs(selections.configs);
        if (selections.protocols.length) setSelectedProtocols(selections.protocols);
        setAccessModes(selections.accessModes);
        setCustomDomains(selections.customDomains);
        setPortAssignments(selections.portAssignments);
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
    setServiceConfigs(createServiceConfigMap());
    setPortAssignments({});
    setSelectedProtocols(["hysteria2"]);
    setAccessModes(["direct"]);
    setCustomDomains({});
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


  return (
    <>
      <PageHeader
        title="部署中心"
        description="选择多个协议并分别配置，一次提交批量部署；已有协议与远程配置保持完整。"
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
              <section className="deploy-step-panel">
                <div className="section-heading">
                  <div>
                    <h2>第一步 · 检查并初始化 fq</h2>
                    <p>检测 VPS 上的 fq 是否可用；安装不完整时可以重新安装或修复。</p>
                  </div>
                  <Badge tone={remoteStatus === "ready" ? "good" : remoteStatus === "error" ? "bad" : "neutral"}>
                    {remoteStatus === "ready" ? "fq 可用" : remoteStatus === "loading" ? "检测中" : remoteStatus === "missing-fq" ? "未安装" : remoteStatus === "error" ? "检测失败" : "未检测"}
                  </Badge>
                </div>
                <div className="deploy-step-actions">
                  <Button loading={remoteStatus === "loading"} disabled={remoteStatus === "loading" || installingFq} onClick={() => readRemote(vps.id)}>检测 fq</Button>
                  <Button variant="outline" loading={installingFq} disabled={installingFq} onClick={() => {
                    void run(async () => {
                      const taskId = await call<string>("installFq", vps.id);
                      setInstallTaskId(taskId);
                      setInstallingFq(true);
                    }, "fq 安装 / 修复任务已加入任务中心");
                  }}>
                    <RefreshCw size={14} />
                    {remoteStatus === "ready" ? "重装 / 修复 fq" : "安装 fq"}
                  </Button>
                </div>
                {remoteStatus === "error" && <p className="deploy-inline-error"><AlertCircle size={14} />{remoteError}</p>}
                {remoteStatus === "missing-fq" && <p className="deploy-inline-warning">未检测到 fq，请先安装后再进行域名与协议配置。</p>}
                {installTaskId && <p className="deploy-inline-info">安装任务正在任务中心执行，完成后会自动重新检测。</p>}
              </section>
            )}
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
                    const needsZone = selectedCombinations.some(({ protocol, access }) =>
                      access !== "direct" || !["snell", "vless-reality"].includes(protocol),
                    ) || Object.values(customDomains).some((domain) => !!domain.trim());
                    if (needsZone && !vps.zoneName && !selectedZone)
                      throw new Error("所选服务需要域名或 TLS 证书，请先绑定 Cloudflare Zone");
                    if (selectedZone && selectedZone.id !== vps.zoneId) {
                      await call("saveVps", {
                        ...vps,
                        zoneId: selectedZone.id,
                        zoneName: selectedZone.name,
                        accountId: selectedZone.account.id,
                      });
                    }
                    const selectedKeys = new Set(selectedCombinations.map(({ protocol, access }) => [protocol, access].join(":")));
                    const occupied = new Set([
                      ...(remote?.services || [])
                        .filter((item) => !selectedKeys.has([item.protocol, item.access].join(":")))
                        .map((item) => portKey(transportForProtocol(item.protocol), item.port)),
                      ...(remote?.websites || []).map((item) => portKey("tcp", item.port)),
                    ]);
                    const zoneName = selectedZone?.name || vps.zoneName;
                    const services = selectedCombinations.map(({ protocol, access }) => {
                      const config = serviceConfigs[protocol];
                      const existing = remote?.services.find((item) => item.protocol === protocol && item.access === access);
                      const assignment = portAssignments[[protocol, access].join(":")];
                      let port = existing?.port || assignment?.port || 0;
                      if (!port && vps.kind === "nat") throw new Error(protocolLabels[protocol] + " / " + access + "：请填写独立的内部监听端口");
                      if (!port && vps.kind === "public") port = 0;
                      const listener = portKey(transportForProtocol(protocol), port);
                      if (port && occupied.has(listener)) throw new Error(protocolLabels[protocol] + " / " + access + "：" + transportForProtocol(protocol).toUpperCase() + " 内部端口 " + port + " 已被占用");
                      if (port) occupied.add(listener);
                      const separatePublicPort = vps.kind === "nat" && access !== "argo" && !!assignment?.separatePublicPort;
                      const publicPort = access === "argo" ? 0 : separatePublicPort ? (assignment?.publicPort || 0) : port;
                      if (vps.kind === "nat" && access !== "argo" && !publicPort) throw new Error(protocolLabels[protocol] + " / " + access + "：请填写内部监听端口");
                      const prefix = protocolDomainPrefix[protocol] + "-" + access;
                      const generatedDomain = zoneName ? prefix + "." + vps.namespace + "." + zoneName : "";
                      const customDomain = customDomains[[protocol, access].join(":")] ?? existing?.domain ?? "";
                      return { ...(existing || {}), ...config, id: protocol + "-" + access, protocol, access, port, publicPort, domain: customDomain.trim() || generatedDomain };
                    });
                    // Listener conflicts are transport-aware: TCP and UDP may share a numeric port.
                    await call("deploy", { vpsId: vps.id, services });
                    } finally {
                      setDeploying(false);
                    }
                  }, "部署任务已加入队列，请在任务中心查看执行与回滚结果");
                }}
              >
                <div className="section-heading"><h2>部署协议服务</h2><Badge tone="blue">sing-box</Badge></div>
                <div className="protocol-grid">
                  {Object.entries(protocolLabels).map(([id, label]) => {
                    const selected = selectedProtocols.includes(id as Service["protocol"]);
                    return <label key={id} className={"protocol-choice " + (selected ? "active" : "")}>
                      <Checkbox checked={selected} onCheckedChange={(checked) => setSelectedProtocols((current) => checked ? [...current, id as Service["protocol"]] : current.filter((item) => item !== id))} />
                      <Network size={19} /><span>{label}</span>
                      {remote?.services.some((item) => item.protocol === id) && <Badge tone="good">已部署</Badge>}
                    </label>;
                  })}
                </div>
                <div className="protocol-settings-list">
                  {selectedProtocols.map((protocol) => {
                    const config = serviceConfigs[protocol];
                    const accesses = protocol === "vless-ws" ? accessModes : ["direct" as const];
                    const needsDomain = !["snell", "vless-reality"].includes(protocol);
                    const usesPassword = ["hysteria2", "tuic", "anytls", "snell"].includes(protocol);
                    const usesUUID = ["tuic", "vless-ws", "vless-reality"].includes(protocol);
                    return <section className="protocol-settings-card" key={protocol}>
                      <div className="section-heading"><div><h3>{protocolLabels[protocol]} 设置</h3><p>{protocolDescriptions[protocol]}</p></div><Badge tone="blue">已选择</Badge></div>
                      <div className="form-grid">
                        <Field label="协议出站"><Select value={config.egress} onValueChange={(value) => updateService(protocol, "egress", value as Service["egress"])}><option value="DIRECT">DIRECT</option><option value="WARP">WARP</option></Select></Field>
                        {usesPassword && <Field label={protocol === "snell" ? "PSK" : "密码"} hint="留空由 fq 为此协议生成随机凭据。"><Input type="password" autoComplete="off" value={config.password} onChange={(e) => updateService(protocol, "password", e.target.value)} /></Field>}
                        {usesUUID && <Field label="UUID" hint="留空自动生成；同一协议的不同接入方式共用此 UUID。"><Input value={config.uuid} onChange={(e) => updateService(protocol, "uuid", e.target.value)} /></Field>}
                        {protocol === "vless-ws" && <Field label="WebSocket 路径"><Input value={config.path} onChange={(e) => updateService(protocol, "path", e.target.value)} /></Field>}
                        {protocol === "vless-reality" && <Field label="Reality 握手目标"><Input required value={config.realityServer} onChange={(e) => updateService(protocol, "realityServer", e.target.value)} /></Field>}
                        {protocol === "vless-reality" && <Field label="Reality 握手端口"><Input type="number" min={1} max={65535} value={config.realityPort} onChange={(e) => updateService(protocol, "realityPort", Number(e.target.value))} /></Field>}
                      </div>
                      {protocol === "vless-ws" && (
                        <section className="access-mode-panel">
                          <div className="section-heading">
                            <div>
                              <h3>接入方式</h3>
                              <p>可同时选择一种或多种入口；每个入口分别配置监听端口、NAT 映射端口和域名。</p>
                            </div>
                            <Badge tone="blue">多选</Badge>
                          </div>
                          <div className="access-mode-options">
                            {(["direct", "cdn", "argo"] as const).map((access) => {
                              const checked = accessModes.includes(access);
                              const label = access === "direct" ? "直连" : access === "cdn" ? "Cloudflare CDN" : "Argo Tunnel";
                              return (
                                <label key={access} className={"access-mode-choice " + (checked ? "active" : "")}>
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={(nextChecked) => setAccessModes((current) =>
                                      nextChecked
                                        ? current.includes(access) ? current : [...current, access]
                                        : current.filter((item) => item !== access),
                                    )}
                                  />
                                  <span>{label}</span>
                                </label>
                              );
                            })}
                          </div>
                        </section>
                      )}
                      <div className="service-access-config-list">
                        {accesses.map((access) => {
                          const key = [protocol, access].join(":");
                          const existing = remote?.services.find((item) => item.protocol === protocol && item.access === access);
                          const assignment: ServicePortConfig = portAssignments[key] || {
                            port: existing?.port || 0,
                            publicPort: existing?.publicPort || existing?.port || 0,
                            separatePublicPort: !!existing && existing.publicPort > 0 && existing.publicPort !== existing.port,
                          };
                          const accessLabel = access === "direct" ? "直连" : access === "cdn" ? "Cloudflare CDN" : "Argo Tunnel";
                          const suggested = protocolDomainPrefix[protocol] + "-" + access + "." + vps.namespace + "." + (vps.zoneName || "your-domain");
                          return <section className="service-access-config" key={key}>
                            <div className="section-heading"><div><h4>{protocol === "vless-ws" ? accessLabel + "入口" : "监听端口"}</h4>{protocol === "vless-ws" && <p>此入口独立配置内部监听端口；公网映射默认与内部端口相同。</p>}</div></div>
                            <div className="form-grid">
                              <Field label="内部监听端口" hint={vps.kind === "nat" ? "填写此服务在 VPS 内部实际监听的端口。" : "填 0 时由系统自动分配。"}>
                                <Input type="number" min={vps.kind === "nat" ? 1 : 0} max={65535} value={assignment.port} onChange={(e) => updatePort(protocol, access, "port", Number(e.target.value))} />
                              </Field>
                              {vps.kind === "nat" && access !== "argo" && <div className="port-override-option">
                                <label className="port-override-label">
                                  <Checkbox
                                    checked={assignment.separatePublicPort}
                                    onCheckedChange={(checked) => setPortAssignments((current) => ({
                                      ...current,
                                      [key]: {
                                        ...assignment,
                                        separatePublicPort: checked,
                                        publicPort: checked ? (assignment.publicPort || assignment.port) : assignment.publicPort,
                                      },
                                    }))}
                                  />
                                  <span>公网映射端口不同于内部监听端口</span>
                                </label>
                                {assignment.separatePublicPort && <Field label="公网映射端口" hint="例如内部 8880，公网映射 18880；默认值与内部端口相同。">
                                  <Input type="number" min={1} max={65535} value={assignment.publicPort || assignment.port} onChange={(e) => updatePort(protocol, access, "publicPort", Number(e.target.value))} />
                                </Field>}
                              </div>}
                              {vps.kind === "nat" && access === "argo" && <p className="service-port-note">Argo Tunnel 通过隧道转发到内部监听端口，不需要公网映射端口。</p>}
                              {protocol === "vless-ws" && access === "cdn" && <Field label="Cloudflare Edge HTTPS 端口" hint="这是客户端连接 Cloudflare 使用的端口，与 VPS 公网映射端口不同。">
                                <Select value={String(config.edgePort)} onValueChange={(value) => updateService(protocol, "edgePort", Number(value))}>{[443, 2053, 2083, 2087, 2096, 8443].map((port) => <option key={port} value={port}>{port}</option>)}</Select>
                              </Field>}
                              {vps.zoneId && vps.zoneName && needsDomain && <Field label="域名（可选）" hint={"留空自动使用：" + suggested}>
                                <Input value={customDomains[key] ?? ""} onChange={(e) => setCustomDomains((current) => ({ ...current, [key]: e.target.value }))} placeholder={suggested} />
                              </Field>}
                            </div>
                          </section>;
                        })}
                      </div>
                      {protocol === "vless-ws" && accessModes.includes("argo") && <p className="info-note"><Network size={17} />Argo Tunnel 直接转发到上方配置的内部监听端口，不需要公网映射端口。</p>}
                      {config.egress === "WARP" && <p className="info-note"><Shield size={17} />请先在网络服务中安装并连接 WARP。此选项只改变 {protocolLabels[protocol]} 的出站。</p>}
                    </section>;
                  })}
                </div>
                <div className="form-actions">
                  <Button type="submit" variant="default" loading={deploying} disabled={deploying || selectedProtocols.length === 0 || (selectedProtocols.includes("vless-ws") && accessModes.length === 0)}>
                    <Rocket size={16} />
                    {deploying ? "正在提交批量部署…" : `批量部署到 ${vps.name}（${selectedCombinations.length} 项）`}
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

