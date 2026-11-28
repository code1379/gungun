import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, ExternalLink, Plus, RefreshCw, Search } from "lucide-react";
import type {
  DNSRecord,
  OriginRule,
  TunnelIngress,
  Zone,
} from "../../../main/cloudflare";
import { useApp } from "../api";
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  Checkbox,
} from "../components/ui";
type DNS = DNSRecord & {
  managed: boolean;
  revision: string;
  priority?: number;
};
type Rule = OriginRule & {
  managed: boolean;
  priority: number;
  revision: string;
};
type Tunnel = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  vps: { id: string; name: string }[];
};
type Edge = {
  universal: { enabled: boolean } | null;
  packs:
    | {
        id: string;
        status: string;
        type: string;
        hosts: string[];
        certificates?: { expires_on?: string; issued_on?: string }[];
      }[]
    | null;
  errors: string[];
  hostname: string;
  covered: boolean | null;
};
type Ingress = {
  config: { ingress?: TunnelIngress[] };
  revision: string;
  managedHosts: string[];
};
const tabs = [
  { id: "overview", label: "账号概览" },
  { id: "dns", label: "DNS 管理" },
  { id: "tunnels", label: "Tunnel 管理" },
  { id: "edge", label: "Edge 证书" },
  { id: "origins", label: "Origin Rules" },
] as const;
export default function CloudflarePage() {
  const { data, call, run } = useApp();
  const [audit, setAudit] = useState<Record<string, unknown>[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [zoneId, setZone] = useState("");
  const [accountId, setAccount] = useState("");
  const [tab, setTab] = useState<string>("overview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [dns, setDNS] = useState<DNS[]>([]);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [edge, setEdge] = useState<Edge | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [hostname, setHostname] = useState("");
  const [dnsEdit, setDNSEdit] = useState<Partial<DNS> | null>(null);
  const [ruleEdit, setRuleEdit] = useState<
    (Partial<Rule> & { hostname?: string; port?: number }) | null
  >(null);
  const [external, setExternal] = useState(false);
  const [adopt, setAdopt] = useState(false);
  const [scheme, setScheme] = useState("https");
  const [edgePort, setEdgePort] = useState(443);
  const [internalPort, setInternalPort] = useState(443);
  const [tunnel, setTunnel] = useState<Tunnel | null>(null);
  const [ingress, setIngress] = useState<Ingress | null>(null);
  const [route, setRoute] = useState<{
    hostname: string;
    service: string;
    operation?: "save" | "remove";
  } | null>(null);
  const generation = useRef(0);
  const zone = zones.find((z) => z.id === zoneId);
  const accounts = zones
    .filter(
      (z, i) => zones.findIndex((v) => v.account.id === z.account.id) === i,
    )
    .map((z) => z.account);
  const request = useCallback(
    <T,>(action: string, extra: Record<string, unknown> = {}) =>
      call<T>("cloudflare", {
        action,
        zone: zoneId || undefined,
        account: accountId || undefined,
        ...extra,
      }),
    [call, zoneId, accountId],
  );
  const connect = useCallback(async () => {
    setConnected(false);
    const list = await call<Zone[]>("zones");
    setZones(list);
    setConnected(true);
    setZone((old) =>
      list.some((z) => z.id === old) ? old : list[0]?.id || "",
    );
    setAccount((old) =>
      list.some((z) => z.account.id === old) ? old : list[0]?.account.id || "",
    );
  }, [call]);
  const load = useCallback(async () => {
    if (!zoneId || !accountId) return;
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      if (tab === "dns") {
        const rows = await request<DNS[]>("dns");
        if (current === generation.current) setDNS(rows);
      }
      if (tab === "tunnels") {
        const rows = await request<Tunnel[]>("tunnels");
        if (current === generation.current) setTunnels(rows);
      }
      if (tab === "origins") {
        const rs = await request<{ rules: Rule[] }>("origins");
        if (current === generation.current) setRules(rs.rules);
      }
      if (tab === "edge") {
        const result = await request<Edge>("edge");
        if (current === generation.current) setEdge(result);
      }
    } catch (e) {
      if (current === generation.current)
        setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, [zoneId, accountId, tab, request]);
  useEffect(() => {
    void connect().catch((e) => {
      setConnected(false);
      setError(String(e));
    });
  }, [connect]);
  useEffect(() => {
    setDNS([]);
    setRules([]);
    setTunnels([]);
    setEdge(null);
    setDNSEdit(null);
    setRuleEdit(null);
    setTunnel(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const mutate = async (action: string, extra: Record<string, unknown>) => {
    setBusy(true);
    try {
      await request(action, extra);
      await load();
    } finally {
      setBusy(false);
    }
  };
  const remove = (action: string, item: DNS | Rule, name: string) => {
    if (
      !window.confirm(
        `确认删除 ${name}？${item.managed ? "此操作会影响使用该资源的业务。" : "这是外部资源，可能被其他业务使用；确认后才会删除。"}`,
      )
    )
      return;
    void run(
      () =>
        mutate(action, {
          id: item.id,
          expected: item.revision,
          confirm: true,
          confirmExternal: !item.managed,
        }),
      "资源已删除",
    );
  };
  const inspectTunnel = async (item: Tunnel) => {
    setIngress(null);
    setTunnel(item);
    setIngress(await request<Ingress>("ingress", { id: item.id }));
  };
  return (
    <>
      <PageHeader
        title="Cloudflare"
        description="管理云端接入资源，沿用设置中的账号凭据。"
        leading={<Cloud size={24} />}
        actions={
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await connect();
                await load();
              })
            }
          >
            <RefreshCw size={15} />
            刷新资源
          </Button>
        }
      />
      <div className="cf-resource-header section">
        <Field label="当前账号">
          <Select
            value={accountId}
            onValueChange={(id) => {
              setAccount(id);
              setZone(zones.find((z) => z.account.id === id)?.id || "");
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name || a.id}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Zone">
          <Select value={zoneId} onValueChange={setZone}>
            {zones
              .filter((z) => z.account.id === accountId)
              .map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
          </Select>
        </Field>
        <Badge tone={connected ? "good" : "bad"}>
          {connected ? "API 已连接" : "API 未连接"}
        </Badge>
        <Button
          onClick={() =>
            void run(() =>
              call(
                "openExternal",
                `https://dash.cloudflare.com/${accountId}${zone ? `/${zone.name}` : ""}`,
              ),
            )
          }
        >
          <ExternalLink size={14} />
          控制台
        </Button>
      </div>
      {!data?.settings.cloudflareKey && (
        <p className="hint">
          请先在设置中保存 Cloudflare 邮箱和 Global API Key。
        </p>
      )}
      <div className="toolbar wrap" role="tablist" aria-label="Cloudflare 资源">
        {tabs.map((t) => (
          <Button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            variant={tab === t.id ? "default" : "ghost"}
            onClick={() => {
              setTab(t.id);
              setSearch("");
            }}
          >
            {t.label}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error-text py-3">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="hint py-2">
          正在读取或更新资源…
        </p>
      )}
      {tab === "overview" && (
        <section className="section">
          <h2>账号资源</h2>
          <p>邮箱：{data?.settings.cloudflareEmail || "未配置"}</p>
          <p>
            可访问 {zones.length} 个 Zone。当前账号：
            {accounts.find((a) => a.id === accountId)?.name || "未选择"}
          </p>
          <p className="hint">
            API Key 仅在本机请求 Cloudflare。删除 VPS 或服务不会自动删除
            DNS。旧记录没有可信归属标记时按外部资源处理。
          </p>
          <Button
            onClick={() =>
              void run(async () => {
                const rows = await request<Record<string, unknown>[]>("audit");
                setAudit(rows);
              })
            }
          >
            查看最近操作结果
          </Button>
          <Audit rows={audit} />
        </section>
      )}
      {tab === "dns" && (
        <>
          <div className="toolbar">
            <Search size={15} />
            <Input
              aria-label="搜索域名或内容"
              placeholder="搜索域名或记录内容"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              aria-label="记录类型筛选"
              value={type}
              onValueChange={setType}
            >
              {[
                "all",
                "A",
                "AAAA",
                "CNAME",
                "TXT",
                "MX",
                "NS",
                "CAA",
                "SRV",
              ].map((t) => (
                <option key={t} value={t}>
                  {t === "all" ? "所有类型" : t}
                </option>
              ))}
            </Select>
            <Button
              disabled={!zone || busy}
              onClick={() => {
                setExternal(false);
                setAdopt(false);
                setDNSEdit({
                  type: "A",
                  name: "",
                  content: "",
                  ttl: 1,
                  proxied: true,
                });
              }}
            >
              <Plus size={15} />
              新增记录
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "域名",
                  "类型",
                  "记录内容",
                  "代理状态",
                  "TTL",
                  "归属",
                  "操作",
                ].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {dns
                .filter(
                  (r) =>
                    (type === "all" || r.type === type) &&
                    `${r.name} ${r.content}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                )
                .map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.name}</TableCell>
                    <TableCell>{r.type}</TableCell>
                    <TableCell className="max-w-60 break-all whitespace-normal">
                      {r.content}
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          r.proxied ? "cf-orange" : "text-muted-foreground"
                        }
                      >
                        ●
                      </span>{" "}
                      {r.proxied ? "橙云" : "灰云"}
                    </TableCell>
                    <TableCell>{r.ttl === 1 ? "自动" : `${r.ttl}s`}</TableCell>
                    <TableCell>{r.managed ? "Gungun" : "外部"}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        disabled={
                          busy ||
                          !["A", "AAAA", "CNAME", "TXT", "MX", "NS"].includes(
                            r.type,
                          )
                        }
                        title={
                          ["SRV", "CAA"].includes(r.type)
                            ? "请在 Cloudflare 控制台编辑结构化字段"
                            : undefined
                        }
                        onClick={() => {
                          setExternal(false);
                          setAdopt(false);
                          setDNSEdit(r);
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => remove("dnsDelete", r, r.name)}
                      >
                        删除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </>
      )}
      {tab === "tunnels" && (
        <>
          <p className="hint py-2">
            每台 VPS 复用固定 Tunnel。外部 Tunnel 只读；本页不会创建、删除或重置
            Token。
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                {["名称 / ID", "状态", "关联 VPS", "创建时间", "Ingress"].map(
                  (h) => (
                    <TableHead key={h}>{h}</TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tunnels.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    {t.name}
                    <small className="block text-muted-foreground">
                      {t.id}
                    </small>
                  </TableCell>
                  <TableCell>{t.status}</TableCell>
                  <TableCell>
                    {t.vps.map((v) => v.name).join("、") || "外部 Tunnel"}
                  </TableCell>
                  <TableCell>
                    {t.created_at
                      ? new Date(t.created_at).toLocaleString()
                      : "API 未提供"}
                  </TableCell>
                  <TableCell>
                    <Button
                      disabled={busy}
                      onClick={() => void run(() => inspectTunnel(t))}
                    >
                      查看路由
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      {tab === "edge" && (
        <section className="section">
          <h2>Edge 证书覆盖检查</h2>
          <p>
            Universal SSL：
            {edge?.universal
              ? edge.universal.enabled
                ? "已启用"
                : "已停用"
              : "无法读取"}
          </p>
          {edge?.errors.map((e) => (
            <p className="error-text" key={e}>
              {e}。请检查账号权限或前往控制台。
            </p>
          ))}
          <div className="toolbar">
            <Input
              aria-label="检查 CDN 域名"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder={`cdn.xxx.${zone?.name || "example.com"}`}
            />
            <Button
              disabled={busy || !hostname}
              onClick={() =>
                void run(async () =>
                  setEdge(await request<Edge>("edge", { data: hostname })),
                )
              }
            >
              检查覆盖
            </Button>
          </div>
          {edge?.hostname && (
            <p role="status">
              {edge.hostname}：
              {edge.covered === null
                ? "无法确定覆盖情况"
                : edge.covered
                  ? "已被当前生效 Edge 证书覆盖，可用于 CDN HTTPS"
                  : "未被生效证书覆盖，暂不满足 CDN HTTPS 要求"}
            </p>
          )}
          <p className="hint">
            通配符只覆盖一级子域。证书覆盖不代表 DNS、源站或 Tunnel 已连通。
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>类型 / 状态</TableHead>
                <TableHead>覆盖域名</TableHead>
                <TableHead>有效期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {edge?.packs?.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    {p.type} / {p.status}
                  </TableCell>
                  <TableCell>{p.hosts.join("、")}</TableCell>
                  <TableCell>
                    {p.certificates
                      ?.map((c) => c.expires_on)
                      .filter(Boolean)
                      .join("、") || "API 未提供"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      {tab === "origins" && (
        <>
          <div className="toolbar">
            <Input
              placeholder="搜索匹配条件"
              aria-label="搜索 Origin Rules"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button
              disabled={!zone || busy}
              onClick={() => {
                setExternal(false);
                setScheme("https");
                setEdgePort(443);
                setInternalPort(443);
                setRuleEdit({
                  hostname: "",
                  expression: "",
                  port: 443,
                  enabled: true,
                  priority: rules.length + 1,
                });
              }}
            >
              <Plus size={15} />
              创建规则
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "优先级",
                  "规则 / 条件",
                  "回源公网端口",
                  "状态",
                  "归属",
                  "操作",
                ].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules
                .filter((r) =>
                  `${r.description} ${r.expression}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.priority}</TableCell>
                    <TableCell className="max-w-96 whitespace-normal break-all">
                      {r.description}
                      <small className="block text-muted-foreground">
                        {r.expression}
                      </small>
                    </TableCell>
                    <TableCell>
                      {r.action_parameters?.origin?.port || "未重写"}
                    </TableCell>
                    <TableCell>
                      {r.enabled === false ? "已停用" : "已启用"}
                    </TableCell>
                    <TableCell>{r.managed ? "Gungun" : "外部"}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setExternal(false);
                          setRuleEdit({
                            ...r,
                            port: r.action_parameters?.origin?.port || 443,
                          });
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          remove(
                            "originDelete",
                            r,
                            r.description || r.id || "规则",
                          )
                        }
                      >
                        删除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
          <p className="hint py-2">
            与部署中心共用同一 Zone 的 Origin Rules 和 Gungun
            域名标识；只更新指定规则，保留其他业务规则。
          </p>
        </>
      )}
      {zoneId &&
        !busy &&
        !error &&
        ((tab === "dns" && !dns.length) ||
          (tab === "tunnels" && !tunnels.length) ||
          (tab === "origins" && !rules.length)) && (
          <Empty title="暂无资源">可刷新资源，或使用上方操作创建。</Empty>
        )}
      <Modal
        open={!!dnsEdit}
        onClose={() => setDNSEdit(null)}
        title={dnsEdit?.id ? "编辑 DNS 记录" : "新增 DNS 记录"}
      >
        {dnsEdit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!window.confirm(`确认保存 ${dnsEdit.name} 的 DNS 记录？`))
                return;
              void run(async () => {
                await mutate("dnsSave", {
                  id: dnsEdit.id,
                  expected: dnsEdit.revision,
                  confirm: true,
                  confirmExternal: external,
                  adopt,
                  data: {
                    type: dnsEdit.type,
                    name: dnsEdit.name,
                    content: dnsEdit.content,
                    ttl: dnsEdit.ttl,
                    proxied: dnsEdit.proxied,
                    priority: dnsEdit.priority,
                  },
                });
                setDNSEdit(null);
              }, "DNS 记录已保存");
            }}
          >
            <Field label="类型">
              <Select
                value={dnsEdit.type}
                onValueChange={(v) =>
                  setDNSEdit({
                    ...dnsEdit,
                    type: v,
                    priority: v === "MX" ? dnsEdit.priority || 0 : undefined,
                    proxied:
                      ["A", "AAAA", "CNAME"].includes(v) && dnsEdit.proxied,
                  })
                }
              >
                {["A", "AAAA", "CNAME", "TXT", "MX", "NS"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="完整域名">
              <Input
                required
                value={dnsEdit.name}
                onChange={(e) =>
                  setDNSEdit({ ...dnsEdit, name: e.target.value })
                }
              />
            </Field>
            <Field label="记录内容">
              <Textarea
                required
                value={dnsEdit.content}
                onChange={(e) =>
                  setDNSEdit({ ...dnsEdit, content: e.target.value })
                }
              />
            </Field>
            <Field label="TTL（1 为自动）">
              <Input
                type="number"
                min={1}
                max={86400}
                value={dnsEdit.ttl}
                onChange={(e) =>
                  setDNSEdit({ ...dnsEdit, ttl: Number(e.target.value) })
                }
              />
            </Field>
            {dnsEdit.type === "MX" && (
              <Field label="优先级">
                <Input
                  type="number"
                  min={0}
                  max={65535}
                  value={dnsEdit.priority || 0}
                  onChange={(e) =>
                    setDNSEdit({ ...dnsEdit, priority: Number(e.target.value) })
                  }
                />
              </Field>
            )}
            <label className="flex gap-2 py-2">
              <Checkbox
                checked={!!dnsEdit.proxied}
                disabled={!["A", "AAAA", "CNAME"].includes(dnsEdit.type || "")}
                onCheckedChange={(v) =>
                  setDNSEdit({ ...dnsEdit, proxied: v === true })
                }
              />
              橙云代理
            </label>
            {dnsEdit.id && !dnsEdit.managed && (
              <>
                <ExternalConfirmation checked={external} change={setExternal} />
                <label className="flex gap-2 py-2">
                  <Checkbox
                    checked={adopt}
                    onCheckedChange={(v) => setAdopt(v === true)}
                  />
                  接管为 Gungun 管理的 DNS（允许后续部署更新）
                </label>
              </>
            )}
            <Button
              type="submit"
              loading={busy}
              disabled={!!dnsEdit.id && !dnsEdit.managed && !external}
            >
              确认保存
            </Button>
          </form>
        )}
      </Modal>
      <Modal
        open={!!ruleEdit}
        onClose={() => setRuleEdit(null)}
        title={ruleEdit?.id ? "编辑 Origin Rule" : "创建 Origin Rule"}
        description="回源端口只决定 Cloudflare 连接 VPS 的公网端口，无法设置 NAT 映射或 sing-box 监听。"
      >
        {ruleEdit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!window.confirm("确认修改此 Origin Rule？")) return;
              void run(async () => {
                await mutate("originSave", {
                  id: ruleEdit.id,
                  expected: ruleEdit.revision,
                  confirm: true,
                  confirmExternal: external,
                  data: {
                    hostname: ruleEdit.hostname || undefined,
                    expression: ruleEdit.expression,
                    port: ruleEdit.port,
                    enabled: ruleEdit.enabled !== false,
                    priority: ruleEdit.priority,
                  },
                });
                setRuleEdit(null);
              }, "Origin Rule 已保存");
            }}
          >
            {!ruleEdit.id && (
              <Field label="匹配域名">
                <Input
                  required
                  value={ruleEdit.hostname}
                  onChange={(e) =>
                    setRuleEdit({
                      ...ruleEdit,
                      hostname: e.target.value,
                      expression: `(http.host eq ${JSON.stringify(e.target.value)})`,
                    })
                  }
                />
              </Field>
            )}
            <Field label="匹配条件">
              <Textarea
                required
                value={ruleEdit.expression}
                onChange={(e) =>
                  setRuleEdit({ ...ruleEdit, expression: e.target.value })
                }
              />
            </Field>
            <div className="form-grid">
              <Field label="客户端接入方式">
                <Select
                  value={scheme}
                  onValueChange={(v) => {
                    setScheme(v);
                    setEdgePort(v === "http" ? 80 : 443);
                    if (
                      !ruleEdit.id &&
                      [80, 443].includes(ruleEdit.port || 443)
                    )
                      setRuleEdit({
                        ...ruleEdit,
                        port: v === "http" ? 80 : 443,
                      });
                    setInternalPort(v === "http" ? 80 : 443);
                  }}
                >
                  <option value="https">HTTPS</option>
                  <option value="http">HTTP</option>
                </Select>
              </Field>
              <Field label="Edge 端口（参考）">
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={edgePort}
                  onChange={(e) => setEdgePort(Number(e.target.value))}
                />
              </Field>
              <Field label="VPS 公网映射 / 回源目标端口">
                <Input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={ruleEdit.port}
                  onChange={(e) =>
                    setRuleEdit({ ...ruleEdit, port: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="VPS 内部监听端口（参考）">
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={internalPort}
                  onChange={(e) => setInternalPort(Number(e.target.value))}
                />
              </Field>
            </div>
            <p className="hint">
              Edge {scheme.toUpperCase()} :{edgePort} → VPS 公网 :
              {ruleEdit.port} → NAT / 内部监听 :{internalPort}
              。仅公网回源端口会写入此规则，另外两个端口需在部署中心和 VPS
              核对。
            </p>
            <Field label="优先级（从 1 开始）">
              <Input
                type="number"
                min={1}
                value={ruleEdit.priority || 1}
                onChange={(e) =>
                  setRuleEdit({ ...ruleEdit, priority: Number(e.target.value) })
                }
              />
            </Field>
            <label className="flex gap-2 py-2">
              <Checkbox
                checked={ruleEdit.enabled !== false}
                onCheckedChange={(v) =>
                  setRuleEdit({ ...ruleEdit, enabled: v === true })
                }
              />
              启用规则
            </label>
            {ruleEdit.id && !ruleEdit.managed && (
              <ExternalConfirmation checked={external} change={setExternal} />
            )}
            <Button
              type="submit"
              loading={busy}
              disabled={!!ruleEdit.id && !ruleEdit.managed && !external}
            >
              确认保存
            </Button>
          </form>
        )}
      </Modal>
      <Modal
        wide
        open={!!tunnel}
        onClose={() => {
          setTunnel(null);
          setRoute(null);
        }}
        title={tunnel?.name || "Tunnel 路由"}
      >
        <p className="hint">
          关联 VPS：
          {tunnel?.vps.map((v) => v.name).join("、") ||
            "无，外部 Tunnel 仅查看"}
        </p>
        {ingress?.config.ingress?.map((r, i) => (
          <div className="section" key={i}>
            <p>
              {r.hostname || "兜底路由"} → {r.service}
            </p>
            {r.hostname &&
              !r.path &&
              ingress.managedHosts.includes(r.hostname) && (
                <>
                  <Button
                    onClick={() =>
                      setRoute({ hostname: r.hostname!, service: r.service })
                    }
                  >
                    编辑 Gungun 路由
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setRoute({
                        hostname: r.hostname!,
                        service: r.service,
                        operation: "remove",
                      })
                    }
                  >
                    删除路由…
                  </Button>
                </>
              )}
          </div>
        ))}
        {ingress?.managedHosts
          .filter(
            (host) => !ingress.config.ingress?.some((r) => r.hostname === host),
          )
          .map((host) => (
            <Button
              key={host}
              onClick={() =>
                setRoute({ hostname: host, service: "http://127.0.0.1:80" })
              }
            >
              恢复缺失路由：{host}
            </Button>
          ))}
        {route && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (
                !window.confirm(`确认修改 ${route.hostname} 的 Tunnel 路由？`)
              )
                return;
              void run(async () => {
                await mutate("ingressSave", {
                  id: tunnel!.id,
                  expected: ingress!.revision,
                  confirm: true,
                  data: route,
                });
                await inspectTunnel(tunnel!);
                setRoute(null);
              }, "路由已保存");
            }}
          >
            <p className="hint">
              {route.operation === "remove"
                ? "删除此 Gungun 路由会中断对应域名的 Tunnel 接入；DNS 和 VPS 服务会保留。"
                : route.hostname}
            </p>
            <Field label="VPS 本地目标（HTTP / HTTPS）">
              <Input
                disabled={route.operation === "remove"}
                value={route.service}
                onChange={(e) =>
                  setRoute({ ...route, service: e.target.value })
                }
              />
            </Field>
            <Button type="submit" loading={busy}>
              {route.operation === "remove" ? "确认删除路由" : "确认保存路由"}
            </Button>
          </form>
        )}
      </Modal>
    </>
  );
}
function Audit({ rows }: { rows: Record<string, unknown>[] }) {
  return rows.length ? (
    <div className="mt-4 max-h-80 overflow-auto text-xs">
      {rows.map((row) => (
        <p key={String(row.id)}>
          {String(row.at)} {String(row.operation)} {String(row.resource)}{" "}
          {row.ok ? "成功" : "失败"}
        </p>
      ))}
    </div>
  ) : null;
}
function ExternalConfirmation({
  checked,
  change,
}: {
  checked: boolean;
  change: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 py-3 text-destructive">
      <Checkbox checked={checked} onCheckedChange={(v) => change(v === true)} />
      这是外部资源，我已核验其他业务并确认修改。
    </label>
  );
}
