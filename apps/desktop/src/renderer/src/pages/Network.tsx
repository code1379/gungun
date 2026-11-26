import { useState } from "react";
import { Plus, Globe, Shield, RefreshCw, DatabaseBackup } from "lucide-react";
import type { RemoteState, Website } from "@gungun/domain";
import { useApp } from "../api";
import {
  Badge,
  Button,
  Confirm,
  Empty,
  Field,
  Modal,
  PageHeader,
  pretty,
  protocolLabels,
} from "../components/ui";
export default function Network() {
  const { data, call, run } = useApp();
  const [vpsId, setVpsId] = useState("");
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [website, setWebsite] = useState<Website | null>(null);
  const [output, setOutput] = useState<unknown>(null);
  const [backups, setBackups] = useState<string[]>([]);
  const [backupId, setBackupId] = useState("");
  const [tab, setTab] = useState("services");
  if (!data) return null;
  const vps = data.vps.find((v) => v.id === vpsId);
  const load = async (id = vpsId) => {
    setRemote(
      await call<RemoteState>("remoteRead", { vpsId: id, action: "config" }),
    );
  };
  const action = (name: string) => {
    void run(
      () => call("remoteAction", { vpsId, action: name }),
      "任务已加入队列",
    );
  };
  return (
    <>
      <PageHeader
        title="网络服务"
        description="管理远程协议、网站、WARP 与配置备份。"
        actions={
          <>
            <select
              className="inline-select"
              value={vpsId}
              onChange={(e) => {
                const id = e.target.value;
                setVpsId(id);
                setRemote(null);
                setOutput(null);
                setBackups([]);
                if (id) void run(() => load(id));
              }}
            >
              <option value="">选择 VPS</option>
              {data.vps.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <Button
              disabled={!vpsId}
              onClick={() => {
                void run(() => load());
              }}
            >
              <RefreshCw size={15} />
              刷新
            </Button>
          </>
        }
      />
      {vps ? (
        <>
          <div className="tag-bar">
            {[
              { id: "services", name: "协议服务" },
              { id: "websites", name: "网站与转发" },
              { id: "warp", name: "WARP" },
              { id: "backups", name: "备份与证书" },
            ].map((t) => (
              <button
                key={t.id}
                className={`tag-tab ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
          {tab === "services" && (
            <>
              <div className="section-heading">
                <h2>运行配置</h2>
                <Button onClick={() => action("restart")}>
                  验证并重启服务
                </Button>
              </div>
              {remote?.services.length ? (
                <div className="host-list">
                  {remote.services.map((s) => (
                    <div className="host-row" key={s.id}>
                      <div className="host-symbol">
                        <Globe size={19} />
                      </div>
                      <div className="grow">
                        <strong>{protocolLabels[s.protocol]}</strong>
                        <p>
                          监听 {s.port} · 公网 {s.publicPort} · Edge{" "}
                          {s.edgePort}
                        </p>
                      </div>
                      <Badge>{s.access.toUpperCase()}</Badge>
                      <Badge tone={s.egress === "WARP" ? "blue" : "neutral"}>
                        {s.egress}
                      </Badge>
                      <Confirm
                        title="删除远程协议服务？"
                        description="fq 将备份配置、预检查、应用并验证；失败会回滚。本机同步时会移除对应节点和受影响链路。"
                        onConfirm={() =>
                          call("removeRemote", {
                            vpsId,
                            kind: "service",
                            id: s.id,
                          })
                        }
                      >
                        删除
                      </Confirm>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="尚未部署协议">
                  在部署中心选择协议并部署，然后刷新查看远程配置。
                </Empty>
              )}
              <div className="toolbar">
                <Button
                  onClick={() => {
                    void run(async () =>
                      setOutput(
                        await call("remoteRead", { vpsId, action: "status" }),
                      ),
                    );
                  }}
                >
                  检查服务状态
                </Button>
                <Button
                  onClick={() => {
                    void run(() =>
                      call("openWindow", { type: "logs", id: vpsId }),
                    );
                  }}
                >
                  实时日志
                </Button>
                <Button onClick={() => action("core update sing-box")}>
                  更新 sing-box
                </Button>
              </div>
            </>
          )}
          {tab === "websites" && (
            <>
              <div className="section-heading">
                <h2>网站与端口转发</h2>
                <Button
                  variant="default"
                  onClick={() =>
                    setWebsite({
                      id: `site-${Date.now()}`,
                      domain: vps.zoneName
                        ? `web-${vps.namespace}.${vps.zoneName}`
                        : "",
                      target: "127.0.0.1",
                      targetPort: 3000,
                      upstreamTLS: false,
                      access: "direct",
                      port: 443,
                      publicPort: 443,
                      edgePort: 443,
                    })
                  }
                >
                  <Plus size={15} />
                  添加网站
                </Button>
              </div>
              {remote?.websites.length ? (
                <div className="host-list">
                  {remote.websites.map((w) => (
                    <div key={w.id} className="host-row">
                      <Globe size={20} />
                      <div className="grow">
                        <strong>{w.domain}</strong>
                        <p>
                          {w.upstreamTLS ? "HTTPS" : "HTTP"} → {w.target}:
                          {w.targetPort}
                        </p>
                      </div>
                      <Badge>{w.access.toUpperCase()}</Badge>
                      <Button onClick={() => setWebsite(w)}>编辑</Button>
                      <Confirm
                        title="删除网站？"
                        description="删除远程 Caddy 路由，配置失败时回滚。DNS 记录保留，避免影响外部使用。"
                        onConfirm={() =>
                          call("removeRemote", {
                            vpsId,
                            kind: "website",
                            id: w.id,
                          })
                        }
                      >
                        删除
                      </Confirm>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="把应用连接到域名">
                  目标服务可运行在任意端口。Caddy 负责 HTTPS
                  与反向代理，支持公网、CDN 和 Argo。
                </Empty>
              )}
            </>
          )}
          {tab === "warp" && (
            <section className="section">
              <div className="feature-heading">
                <Shield size={28} />
                <div>
                  <h2>服务器 WARP</h2>
                  <p>
                    以本机 SOCKS 代理提供出站。各协议单独选择 DIRECT 或 WARP。
                  </p>
                </div>
              </div>
              <p className="hint">
                自动安装支持 Debian / Ubuntu。安装会使用 Cloudflare
                官方软件源，连接时接受 WARP 服务条款。
              </p>
              <div className="toolbar wrap">
                <Button
                  variant="default"
                  onClick={() => action("warp install")}
                >
                  安装并连接 WARP
                </Button>
                <Button onClick={() => action("warp connect")}>连接</Button>
                <Button onClick={() => action("warp disconnect")}>断开</Button>
                <Button onClick={() => action("warp status")}>检查状态</Button>
              </div>
            </section>
          )}
          {tab === "backups" && (
            <>
              <section className="section">
                <div className="feature-heading">
                  <DatabaseBackup size={25} />
                  <div>
                    <h2>配置备份</h2>
                    <p>每次配置变更前自动创建备份，也可以手动备份。</p>
                  </div>
                </div>
                <div className="toolbar">
                  <Button onClick={() => action("backup")}>创建备份</Button>
                  <Button
                    onClick={() => {
                      void run(async () => {
                        const result = await call<{ backups: string[] }>(
                          "remoteRead",
                          { vpsId, action: "backups" },
                        );
                        setBackups(result.backups);
                      });
                    }}
                  >
                    读取备份
                  </Button>
                  <select
                    className="inline-select"
                    value={backupId}
                    onChange={(e) => setBackupId(e.target.value)}
                  >
                    <option value="">选择备份</option>
                    {backups.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={!backupId}
                    onClick={() => {
                      void run(
                        () =>
                          call("remoteAction", {
                            vpsId,
                            action: "restore",
                            backupId,
                          }),
                        "恢复任务已加入队列",
                      );
                    }}
                  >
                    恢复所选备份
                  </Button>
                </div>
              </section>
              <section className="section">
                <h2>独立泛域名证书</h2>
                <dl className="details">
                  <dt>域名</dt>
                  <dd>
                    *.{vps.namespace}.{vps.zoneName || "尚未配置 Zone"}
                  </dd>
                  <dt>到期时间</dt>
                  <dd>
                    {remote?.certificate
                      ? new Date(remote.certificate.notAfter).toLocaleString()
                      : "尚未申请"}
                  </dd>
                </dl>
                <p className="hint">
                  使用 Let's Encrypt DNS-01。Gungun
                  运行时每日检查，临近到期自动续期；Mac 离线时无法执行 DNS-01。
                </p>
                <Button onClick={() => action("renew")}>申请 / 续期证书</Button>
              </section>
            </>
          )}
          {output !== null && <pre className="output">{pretty(output)}</pre>}
        </>
      ) : (
        <Empty title="选择一台 VPS">
          远程服务状态、网站和备份将从 fq 读取。
        </Empty>
      )}
      <Modal
        open={!!website}
        onClose={() => setWebsite(null)}
        title="网站与端口转发"
        description="填写目标地址和端口，自动管理 DNS、Caddy、证书与失败回滚。"
        wide
      >
        {website && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await call("deploy", { vpsId, website });
                setWebsite(null);
              }, "网站部署任务已加入队列");
            }}
          >
            <div className="form-grid">
              <Field label="网站域名">
                <input
                  required
                  value={website.domain}
                  onChange={(e) =>
                    setWebsite({ ...website, domain: e.target.value })
                  }
                />
              </Field>
              <Field label="接入方式">
                <select
                  value={website.access}
                  onChange={(e) => {
                    const access = e.target.value as Website["access"];
                    setWebsite({
                      ...website,
                      access,
                      port: access === "argo" ? 18800 : 443,
                    });
                  }}
                >
                  <option value="direct">公网 IP / 已有端口映射</option>
                  <option value="cdn">Cloudflare CDN</option>
                  <option value="argo">Argo Tunnel</option>
                </select>
              </Field>
              <Field label="目标 IP / 主机名">
                <input
                  required
                  value={website.target}
                  onChange={(e) =>
                    setWebsite({ ...website, target: e.target.value })
                  }
                />
              </Field>
              <Field label="目标端口">
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={website.targetPort}
                  onChange={(e) =>
                    setWebsite({
                      ...website,
                      targetPort: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="回源协议">
                <select
                  value={website.upstreamTLS ? "https" : "http"}
                  onChange={(e) =>
                    setWebsite({
                      ...website,
                      upstreamTLS: e.target.value === "https",
                    })
                  }
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS（验证上游证书）</option>
                </select>
              </Field>
              <Field label="Caddy 内部监听端口">
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={website.port}
                  onChange={(e) =>
                    setWebsite({ ...website, port: Number(e.target.value) })
                  }
                />
              </Field>
              {website.access !== "argo" && (
                <Field
                  label={vps?.kind === "nat" ? "公网映射端口" : "公网端口"}
                >
                  <input
                    required
                    type="number"
                    min={1}
                    max={65535}
                    value={website.publicPort}
                    onChange={(e) =>
                      setWebsite({
                        ...website,
                        publicPort: Number(e.target.value),
                      })
                    }
                  />
                </Field>
              )}
              {website.access === "cdn" && (
                <Field label="Edge HTTPS 端口">
                  <select
                    value={website.edgePort}
                    onChange={(e) =>
                      setWebsite({
                        ...website,
                        edgePort: Number(e.target.value),
                      })
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
            </div>
            <div className="form-actions">
              <Button type="submit" variant="default">
                部署网站
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
