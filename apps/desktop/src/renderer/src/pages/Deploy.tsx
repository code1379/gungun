import { useState } from "react";
import { Rocket, Server, Shield, Network } from "lucide-react";
import type { RemoteState, Service, VPS } from "@gungun/domain";
import { useApp } from "../api";
import {
  Badge,
  Button,
  Empty,
  Field,
  PageHeader,
  protocolLabels,
} from "../components/ui";
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
  if (!data) return null;
  const vps = data.vps.find((v) => v.id === vpsId);
  const update = <K extends keyof Service>(key: K, value: Service[K]) =>
    setService((prev) => ({ ...prev, [key]: value }));
  const selectHost = (id: string) => {
    setVpsId(id);
    setRemote(null);
    void run(async () =>
      setRemote(
        await call<RemoteState>("remoteRead", { vpsId: id, action: "config" }),
      ),
    );
  };
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
            {data.vps.map((v) => (
              <button
                key={v.id}
                className={`deploy-host ${vpsId === v.id ? "active" : ""}`}
                onClick={() => selectHost(v.id)}
              >
                <Server size={18} />
                <span>
                  {v.name}
                  <small>{v.kind === "nat" ? "NAT VPS" : "公网 VPS"}</small>
                </span>
              </button>
            ))}
          </aside>
          <section className="deploy-form">
            {vps ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () => call("deploy", { vpsId: vps.id, service }),
                    "部署任务已加入队列，请在任务中心查看执行与回滚结果",
                  );
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
                    <select
                      value={service.access}
                      onChange={(e) =>
                        update("access", e.target.value as Service["access"])
                      }
                    >
                      <option value="direct">直连</option>
                      {service.protocol === "vless-ws" && (
                        <>
                          <option value="cdn">Cloudflare CDN</option>
                          <option value="argo">Argo Tunnel</option>
                        </>
                      )}
                    </select>
                  </Field>
                  <Field label="协议出站">
                    <select
                      value={service.egress}
                      onChange={(e) =>
                        update("egress", e.target.value as Service["egress"])
                      }
                    >
                      <option value="DIRECT">DIRECT</option>
                      <option value="WARP">WARP</option>
                    </select>
                  </Field>
                  <Field
                    label="内部监听端口"
                    hint={
                      vps.kind === "nat"
                        ? "NAT 主机必须填写内部端口。"
                        : "0 表示自动分配可用端口。"
                    }
                  >
                    <input
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
                      <input
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
                      <select
                        value={service.edgePort}
                        onChange={(e) =>
                          update("edgePort", Number(e.target.value))
                        }
                      >
                        {[443, 2053, 2083, 2087, 2096, 8443].map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {service.protocol !== "vless-reality" && (
                    <Field
                      label="域名"
                      hint={
                        vps.zoneName
                          ? `留空自动使用 ${service.access === "cdn" ? "cdn" : service.access === "argo" ? "argo" : "node"}.${vps.namespace}.${vps.zoneName}`
                          : "请先在 VPS 设置中选择 Cloudflare Zone 以申请证书。"
                      }
                    >
                      <input
                        value={service.domain}
                        onChange={(e) => update("domain", e.target.value)}
                        placeholder="自动生成独立域名"
                      />
                    </Field>
                  )}
                  {service.protocol === "vless-ws" && (
                    <Field label="WebSocket 路径">
                      <input
                        required
                        value={service.path}
                        onChange={(e) => update("path", e.target.value)}
                      />
                    </Field>
                  )}
                  {service.protocol === "vless-reality" && (
                    <>
                      <Field label="Reality 握手目标">
                        <input
                          required
                          value={service.realityServer}
                          onChange={(e) =>
                            update("realityServer", e.target.value)
                          }
                        />
                      </Field>
                      <Field label="Reality 握手端口">
                        <input
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
                    <input
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
                      <input
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
                  <Button type="submit" variant="default">
                    <Rocket size={16} />
                    部署到 {vps.name}
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
