import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { useState } from "react";
import { randomUUID } from "../utils";
import { Plus, MoreHorizontal, ArrowUp, ArrowDown, Download, Upload, RefreshCw, Gauge, Activity, Workflow, Search, Pencil, Trash2, Layers, Tag as TagIcon, Rss, Server } from "lucide-react";
import { nodeSchema, resolveTag, type Chain, type ProxyNode, type Tag, type TestResult } from "@gungun/domain";
import { useApp } from "../api";
import { Badge, Button, Confirm, Empty, Field, Modal, PageHeader, protocolLabels, Checkbox, Select, Input, Table, TableHeader, TableRow, TableHead, TableBody, TableCell, Textarea } from "../components/ui";
type Candidate = {
  address: string;
  latencyMs: number | null;
  speedMBps: number | null;
  error: string | null;
};
export default function Nodes() {
  const { data, call, run } = useApp();
  const [tagId, setTagId] = useState("all");
  const [sourceIds, setSourceIds] = useState(["local"]);
  const [displaySource, setDisplaySource] = useState("local");
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"name" | "latency" | "speed">("name");
  const [editing, setEditing] = useState<ProxyNode | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);
  const [tag, setTag] = useState<Tag | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const [details, setDetails] = useState<string | null>(null);
  const [optimizing, setOptimizing] = useState<ProxyNode | null>(null);
  const [addresses, setAddresses] = useState("");
  const [optTask, setOptTask] = useState("");
  if (!data) return null;
  const isChain = tagId === "chains";
  let nodes: ProxyNode[] = [];
  try {
    nodes = resolveTag(isChain ? "all" : tagId, data.nodes, data.tags);
  } catch {
    nodes = [];
  }
  const subjects: (ProxyNode | Chain)[] = isChain ? data.chains : nodes;
  const result = (id: string): TestResult | undefined =>
    data.results.find(
      (r) =>
        r.subjectId === id &&
        r.kind === (isChain ? "chain" : "node") &&
        r.sourceId === displaySource,
    );
  const visible = subjects
    .filter((n) => n.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "latency"
          ? (result(a.id)?.latencyMs ?? Infinity) -
            (result(b.id)?.latencyMs ?? Infinity)
          : (result(b.id)?.speedMBps ?? -1) - (result(a.id)?.speedMBps ?? -1),
    );
  const currentTag = data.tags.find((t) => t.id === tagId);
  const test = (speed: boolean, subjectIds?: string[]) =>
    run(
      () => call("test", { tagId, sourceIds, speed, subjectIds }),
      "测速任务已加入队列",
    );
  const addNode = () => {
    let target = currentTag;
    if (!target || target.kind === "aggregate")
      target = data.tags.find((t) => t.kind === "manual");
    void run(async () => {
      if (!target) {
        target = {
          id: randomUUID(),
          name: "手动导入",
          kind: "manual",
          tagIds: [],
          url: "",
        };
        await call("saveTag", target);
      }
      setEditing(
        nodeSchema.parse({
          id: randomUUID(),
          name: "新节点",
          protocol: "vless-ws",
          address: "localhost",
          port: 443,
          tagId: target.id,
          source: "manual",
        }),
      );
    });
  };
  const menuSubject = subjects.find((n) => n.id === menu?.id);
  const optResults = (data.tasks.find((t) => t.id === optTask)?.output ||
    []) as Candidate[];
  return (
    <>
      <PageHeader
        title="节点与订阅"
        description="统一管理节点、动态聚合和链式代理。VPS 节点通过 SSH 手动同步。"
        actions={
          <>
            <Button
              onClick={() =>
                setTag({
                  id: randomUUID(),
                  name: "",
                  kind: "manual",
                  tagIds: [],
                  url: "",
                })
              }
            >
              <Plus size={16} />
              新建分组
            </Button>
            <Button
              variant="default"
              onClick={() =>
                isChain
                  ? setChain({
                      id: randomUUID(),
                      name: "新链路",
                      nodeIds: ["", ""],
                    })
                  : addNode()
              }
            >
              <Plus size={16} />
              {isChain ? "创建链路" : "添加节点"}
            </Button>
          </>
        }
      />
      <Tabs value={tagId} onValueChange={(value) => { setTagId(String(value)); setSelected(""); }} orientation="vertical" className="nodes-layout">
        <aside className="nodes-groups-panel">
          <div className="nodes-groups-heading">分组</div>
          <TabsList variant="default" className="node-groups-list" aria-label="节点分组">
        {[
          { id: "all", name: "所有节点" },
          { id: "chains", name: "链式代理" },
          ...data.tags,
        ].map((t) => (
          <TabsTrigger key={t.id} value={t.id} className="node-group-trigger">
            <span className="node-group-icon" aria-hidden="true">
              {t.id === "all" ? <Layers size={15} /> :
                t.id === "chains" ? <Workflow size={15} /> :
                  data.tags.find((tag) => tag.id === t.id)?.kind === "subscription" ? <Rss size={15} /> :
                    data.tags.find((tag) => tag.id === t.id)?.kind === "aggregate" ? <Layers size={15} /> :
                      data.tags.find((tag) => tag.id === t.id)?.kind === "vps" ? <Server size={15} /> :
                        <TagIcon size={15} />}
            </span>
            <span className="node-group-name">{t.name}</span>
            <small className="node-group-count">
              {t.id === "all"
                ? data.nodes.length
                : t.id === "chains"
                  ? data.chains.length
                  : (() => {
                      try {
                        return resolveTag(t.id, data.nodes, data.tags).length;
                      } catch {
                        return 0;
                      }
                    })()}
            </small>
          </TabsTrigger>
        ))}
          </TabsList>
        </aside>
        <TabsContent value={tagId} className="nodes-main">
      <div className="test-toolbar">
        <div className="actions">
          <Button
            onClick={() => {
              void test(false);
            }}
            disabled={!subjects.length}
          >
            <Activity size={15} />
            一键测试真连接延迟
          </Button>
          <Button
            onClick={() => {
              void test(true);
            }}
            disabled={!subjects.length}
          >
            <Gauge size={15} />
            一键多线程测试延迟和速度
          </Button>
        </div>
        <span className="muted">
          当前 Tag · {subjects.length} 项 · 并发 {data.settings.concurrency}
        </span>
      </div>
      <div className="source-toolbar">
        <span className="muted">测试主机</span>
        {[{ id: "local", name: "Mac 本机" }, ...data.vps].map((v) => (
          <label className="checkbox compact" key={v.id}>
            <Checkbox
              
              checked={sourceIds.includes(v.id)}
              onCheckedChange={(checked) =>
                setSourceIds((old) =>
                  checked
                    ? [...old, v.id]
                    : old.filter((id) => id !== v.id),
                )}
            />
            {v.name}
          </label>
        ))}
        <span className="grow" />
        <span className="muted">显示来源</span>
        <Select
          className="inline-select"
          value={displaySource}
          onValueChange={(value) => setDisplaySource(value)}
        >
          <option value="local">Mac 本机</option>
          {data.vps.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="toolbar">
        <div className="search">
          <Search size={16} />
          <Input
            aria-label="搜索节点"
            value={search}
            placeholder="搜索节点"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          className="inline-select"
          value={sort}
          onValueChange={(value) => setSort(value as typeof sort)}
          aria-label="排序"
        >
          <option value="name">按名称</option>
          <option value="latency">延迟从低到高</option>
          <option value="speed">速度从高到低</option>
        </Select>
        <span className="grow" />
        {currentTag?.kind === "subscription" && (
          <Button
            onClick={() => {
              void run(
                () => call("updateSubscription", currentTag.id),
                "订阅更新任务已加入队列",
              );
            }}
          >
            <RefreshCw size={14} />
            更新订阅
          </Button>
        )}
        {currentTag && currentTag.kind !== "vps" && (
          <Button variant="ghost" onClick={() => setTag(currentTag)}>
            <Pencil size={14} />
            分组设置
          </Button>
        )}
        {!isChain && (
          <Button onClick={() => setImportText("")}>
            <Upload size={14} />
            导入
          </Button>
        )}
        <Button
          onClick={() => {
            void run(
              () => call("export", { tagId, format: "mihomo" }),
              "已导出 Mihomo YAML",
            );
          }}
        >
          <Download size={14} />
          Mihomo
        </Button>
        {!isChain && (
          <Button
            onClick={() => {
              void run(
                () => call("export", { tagId, format: "base64" }),
                "已复制 V2Ray Base64 订阅到剪贴板",
              );
            }}
          >
            复制 Base64
          </Button>
        )}
      </div>
      {visible.length ? (
        <div className="table-wrap">
          <Table className="node-table">
            <TableHeader>
              <TableRow>
                <TableHead>节点名称</TableHead>
                <TableHead>{isChain ? "连接顺序" : "协议 / 地址"}</TableHead>
                <TableHead>真连接延迟</TableHead>
                <TableHead>下载速度</TableHead>
                <TableHead aria-label="操作" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((n) => {
                const r = result(n.id);
                return (
                  <TableRow
                    key={n.id}
                    data-state={selected === n.id ? "selected" : undefined}
                    className={selected === n.id ? "bg-primary/10" : ""}
                    onClick={() => setSelected(n.id)}
                    onDoubleClick={() => setDetails(n.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(n.id);
                      setMenu({
                        id: n.id,
                        x: Math.min(e.clientX, window.innerWidth - 225),
                        y: Math.min(e.clientY, window.innerHeight - 310),
                      });
                    }}
                  >
                    <TableCell>
                      <strong>{n.name}</strong>
                      {"nodeIds" in n ? (
                        <Badge tone="blue">{n.nodeIds.length} 跳</Badge>
                      ) : (
                        n.access !== "direct" && (
                          <Badge>{n.access.toUpperCase()}</Badge>
                        )
                      )}
                    </TableCell>
                    <TableCell>
                      {"nodeIds" in n ? (
                        <span className="muted">
                          {n.nodeIds
                            .map(
                              (id) =>
                                data.nodes.find((x) => x.id === id)?.name ||
                                "节点已删除",
                            )
                            .join(" → ")}
                        </span>
                      ) : (
                        <>
                          <span>{protocolLabels[n.protocol]}</span>
                          <small className="address">
                            {n.address}:{n.port}
                          </small>
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      {r?.error ? (
                        <span className="error-text" title={r.error}>
                          失败
                        </span>
                      ) : r?.latencyMs != null ? (
                        <span className="latency">
                          {r.latencyMs.toFixed(0)} ms
                        </span>
                      ) : (
                        <span className="muted">未测试</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {r?.speedMBps != null ? (
                        `${r.speedMBps.toFixed(2)} MB/s`
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        aria-label={`${n.name} 的操作`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenu({
                            id: n.id,
                            x: Math.min(
                              e.clientX - 190,
                              window.innerWidth - 225,
                            ),
                            y: Math.min(e.clientY, window.innerHeight - 310),
                          });
                        }}
                      >
                        <MoreHorizontal size={18} />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <Empty title={isChain ? "创建第一条代理链" : "这个分组还没有节点"}>
          {isChain
            ? "选择已有节点作为第一跳和最终出口，可以调整连接顺序。"
            : "从 VPS 手动同步、更新外部订阅，或导入节点分享链接。"}
        </Empty>
      )}
      {menu && (
        <>
          <div className="menu-dismiss" onClick={() => setMenu(null)} />
          <div
            className="context-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              onClick={() => {
                setDetails(menu.id);
                setMenu(null);
              }}
            >
              查看详情与测试结果
            </button>
            <button
              onClick={() => {
                if (menuSubject) {
                  if ("nodeIds" in menuSubject) setChain(menuSubject);
                  else setEditing(menuSubject);
                }
                setMenu(null);
              }}
            >
              编辑{isChain ? "链路" : "节点"}
            </button>
            <button
              onClick={() => {
                void test(false, [menu.id]);
                setMenu(null);
              }}
            >
              测试真连接延迟
            </button>
            <button
              onClick={() => {
                void test(true, [menu.id]);
                setMenu(null);
              }}
            >
              测试下载速度
            </button>
            {menuSubject &&
              !("nodeIds" in menuSubject) &&
              menuSubject.access !== "direct" && (
                <button
                  onClick={() => {
                    setOptimizing(menuSubject);
                    setOptTask("");
                    setMenu(null);
                  }}
                >
                  优选 IP
                </button>
              )}
            <button
              className="error-text"
              onClick={() => {
                setDetails(menu.id);
                setMenu(null);
              }}
            >
              删除…
            </button>
          </div>
        </>
      )}
      <Modal
        open={!!chain}
        onClose={() => setChain(null)}
        title="链式代理"
        description="按顺序选择节点：Mac → 第一跳 → 最终出口。参数始终从原始节点读取。"
      >
        {chain && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await call("saveChain", chain);
                setChain(null);
              }, "代理链已保存");
            }}
          >
            <Field label="链路名称">
              <Input
                required
                value={chain.name}
                onChange={(e) => setChain({ ...chain, name: e.target.value })}
              />
            </Field>
            {chain.nodeIds.map((id, i) => (
              <div className="chain-hop" key={i}>
                <div className="hop-number">{i + 1}</div>
                <Field
                  label={
                    i === 0
                      ? "第一跳"
                      : i === chain.nodeIds.length - 1
                        ? "最终出口"
                        : `第 ${i + 1} 跳`
                  }
                >
                  <Select
                    required
                    value={id}
                    onValueChange={(value) =>
                      setChain({
                        ...chain,
                        nodeIds: chain.nodeIds.map((n, j) =>
                          j === i ? value : n,
                        ),
                      })}
                  >
                    <option value="">选择节点</option>
                    {data.nodes.map((n) => (
                      <option
                        key={n.id}
                        value={n.id}
                        disabled={chain.nodeIds.includes(n.id) && n.id !== id}
                      >
                        {n.name} · {protocolLabels[n.protocol]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  type="button"
                  disabled={i === 0}
                  aria-label="上移"
                  onClick={() => {
                    const ids = [...chain.nodeIds];
                    [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                    setChain({ ...chain, nodeIds: ids });
                  }}
                >
                  <ArrowUp size={15} />
                </Button>
                <Button
                  type="button"
                  disabled={i === chain.nodeIds.length - 1}
                  aria-label="下移"
                  onClick={() => {
                    const ids = [...chain.nodeIds];
                    [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
                    setChain({ ...chain, nodeIds: ids });
                  }}
                >
                  <ArrowDown size={15} />
                </Button>
                {chain.nodeIds.length > 2 && (
                  <Button
                    type="button"
                    aria-label="移除此跳"
                    onClick={() =>
                      setChain({
                        ...chain,
                        nodeIds: chain.nodeIds.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </Button>
                )}
              </div>
            ))}
            <p className="hint">
              后续跳暂不支持 Hysteria2 / TUIC 的 UDP 拨号。请使用 VLESS、AnyTLS
              或 Snell 出口。QUIC 第一跳后仅支持 AnyTLS / Snell：当前核心 QUIC → VLESS 实测下载不稳定。保存后请测试完整链路。
            </p>
            <div className="form-actions">
              <Button
                type="button"
                disabled={chain.nodeIds.length >= 8}
                onClick={() =>
                  setChain({ ...chain, nodeIds: [...chain.nodeIds, ""] })
                }
              >
                添加一跳
              </Button>
              <span className="grow" />
              <Button type="submit" variant="default">
                保存链路
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="编辑节点"
        description="仅修改本机节点。VPS 节点重新同步时以远程配置为准。"
        wide
      >
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await call("saveNode", editing);
                setEditing(null);
              }, "节点已保存");
            }}
          >
            <div className="form-grid">
              {(
                [
                  { key: "name", label: "名称" },
                  { key: "address", label: "Address" },
                  { key: "port", label: "端口", type: "number" },
                  { key: "sni", label: "TLS Server Name" },
                  { key: "uuid", label: "UUID" },
                  { key: "password", label: "密码 / PSK", type: "password" },
                  { key: "host", label: "WebSocket Host" },
                  { key: "path", label: "WebSocket Path" },
                  { key: "publicKey", label: "Reality 公钥" },
                  { key: "shortId", label: "Reality Short ID" },
                ] as const
              )
                .filter((f) => {
                  if (["name", "address", "port"].includes(f.key)) return true;
                  if (f.key === "sni") return editing.protocol !== "snell";
                  if (f.key === "uuid")
                    return (
                      editing.protocol.startsWith("vless") ||
                      editing.protocol === "tuic"
                    );
                  if (f.key === "password")
                    return !editing.protocol.startsWith("vless");
                  if (f.key === "host" || f.key === "path")
                    return editing.protocol === "vless-ws";
                  return editing.protocol === "vless-reality";
                })
                .map((f) => (
                  <Field key={f.key} label={f.label}>
                    <Input
                      type={"type" in f ? f.type : "text"}
                      required={["name", "address", "port"].includes(f.key)}
                      value={editing[f.key]}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          [f.key]:
                            f.key === "port"
                              ? Number(e.target.value)
                              : e.target.value,
                        })
                      }
                    />
                  </Field>
                ))}
              <Field label="协议">
                <Select
                  value={editing.protocol}
                  onValueChange={(value) =>
                    setEditing({
                      ...editing,
                      protocol: value as ProxyNode["protocol"],
                      access:
                        value === "vless-ws"
                          ? editing.access
                          : "direct",
                    })}
                >
                  {Object.entries(protocolLabels).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              {editing.protocol === "vless-ws" && (
                <Field
                  label="接入方式"
                  hint="外部 CDN / Argo 节点可标记后使用优选 IP。"
                >
                  <Select
                    value={editing.access}
                    onValueChange={(value) =>
                      setEditing({
                        ...editing,
                        access: value as ProxyNode["access"],
                      })}
                  >
                    <option value="direct">直连</option>
                    <option value="cdn">Cloudflare CDN</option>
                    <option value="argo">Argo Tunnel</option>
                  </Select>
                </Field>
              )}
              {editing.protocol === "snell" ? (
                <Field label="Snell v6 模式">
                  <Select
                    value={editing.snellMode}
                    onValueChange={(value) =>
                      setEditing({
                        ...editing,
                        snellMode: value as ProxyNode["snellMode"],
                      })}
                  >
                    {["default", "unshaped", "unsafe-raw"].map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Field
                  label="ALPN"
                  hint="多个值用逗号分隔，留空使用协议默认值。"
                >
                  <Input
                    value={editing.alpn.join(",")}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        alpn: e.target.value
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
              )}
              {!["snell", "vless-reality"].includes(editing.protocol) && (
                <Field
                  label="证书 SHA256 固定指纹"
                  hint="仅用于保留导入和导出参数；sing-box 不支持整张证书指纹，填写后无法执行测试。请使用可信证书。"
                >
                  <Input
                    value={editing.certificatePin}
                    onChange={(e) =>
                      setEditing({ ...editing, certificatePin: e.target.value })
                    }
                  />
                </Field>
              )}
              {editing.protocol === "hysteria2" && (
                <>
                  <Field label="Hysteria2 混淆">
                    <Select
                      value={editing.obfs}
                      onValueChange={(value) =>
                        setEditing({
                          ...editing,
                          obfs: value as ProxyNode["obfs"],
                        })}
                    >
                      <option value="">无</option>
                      <option value="salamander">Salamander</option>
                    </Select>
                  </Field>
                  {editing.obfs && (
                    <Field label="混淆密码">
                      <Input
                        type="password"
                        required
                        value={editing.obfsPassword}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            obfsPassword: e.target.value,
                          })
                        }
                      />
                    </Field>
                  )}
                </>
              )}
              <Field label="所属 Tag">
                <Select
                  value={editing.tagId}
                  onValueChange={(value) =>
                    setEditing({ ...editing, tagId: value })}
                >
                  {data.tags
                    .filter((t) => t.kind !== "aggregate")
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="TLS">
                <label className="checkbox">
                  <Checkbox
                    
                    checked={editing.tls}
                    onCheckedChange={(checked) =>
                      setEditing({ ...editing, tls: checked })}
                  />
                  启用 TLS
                </label>
              </Field>
              <Field label="证书校验">
                <label className="checkbox">
                  <Checkbox
                    
                    checked={editing.insecure}
                    onCheckedChange={(checked) =>
                      setEditing({ ...editing, insecure: checked })}
                  />
                  跳过证书校验
                </label>
              </Field>
            </div>
            <div className="form-actions">
              <Button type="submit" variant="default">
                保存节点
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal open={!!tag} onClose={() => setTag(null)} title="分组设置">
        {tag && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await call("saveTag", tag);
                setTagId(tag.id);
                setTag(null);
              }, "分组已保存");
            }}
          >
            <Field label="名称">
              <Input
                required
                value={tag.name}
                onChange={(e) => setTag({ ...tag, name: e.target.value })}
              />
            </Field>
            <Field label="类型">
              <Select
                value={tag.kind}
                onValueChange={(value) =>
                  setTag({ ...tag, kind: value as Tag["kind"] })}
              >
                <option value="manual">手动分组</option>
                <option value="subscription">外部订阅</option>
                <option value="aggregate">动态聚合</option>
              </Select>
            </Field>
            {tag.kind === "subscription" && (
              <Field label="订阅 URL">
                <Input
                  type="url"
                  required
                  value={tag.url}
                  onChange={(e) => setTag({ ...tag, url: e.target.value })}
                />
              </Field>
            )}
            {tag.kind === "aggregate" && (
              <Field
                label="映射 Tag"
                hint="节点保持原始 ID，新增、编辑和删除会自动反映。"
              >
                {data.tags
                  .filter((t) => t.id !== tag.id)
                  .map((t) => (
                    <label className="checkbox" key={t.id}>
                      <Checkbox
                        
                        checked={tag.tagIds.includes(t.id)}
                        onCheckedChange={(checked) =>
                          setTag({
                            ...tag,
                            tagIds: checked
                              ? [...tag.tagIds, t.id]
                              : tag.tagIds.filter((id) => id !== t.id),
                          })}
                      />
                      {t.name}
                    </label>
                  ))}
              </Field>
            )}
            <div className="form-actions">
              {data.tags.some((t) => t.id === tag.id) && (
                <Confirm
                  title="删除这个分组？"
                  description="同时删除该组节点及引用它们的代理链；聚合组本身不存储节点。"
                  onConfirm={async () => {
                    await call("delete", {
                      kind: "tags",
                      id: tag.id,
                      confirmAffected: true,
                    });
                    setTag(null);
                    setTagId("all");
                  }}
                >
                  删除分组
                </Confirm>
              )}
              <span className="grow" />
              <Button type="submit" variant="default">
                保存分组
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={importText !== null}
        onClose={() => setImportText(null)}
        title="导入节点"
        description="支持分享链接、V2Ray Base64 和 Mihomo YAML。"
      >
        {importText !== null && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                let target = currentTag;
                if (!target || target.kind === "aggregate") {
                  target = data.tags.find((t) => t.kind === "manual");
                  if (!target) {
                    target = {
                      id: randomUUID(),
                      name: "手动导入",
                      kind: "manual",
                      tagIds: [],
                      url: "",
                    };
                    await call("saveTag", target);
                  }
                }
                await call("importSubscription", {
                  tagId: target.id,
                  text: importText,
                  replace: false,
                });
                setTagId(target.id);
                setImportText(null);
              }, "节点已导入");
            }}
          >
            <Field label="节点内容">
              <Textarea
                required
                rows={10}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="粘贴节点分享链接或订阅内容"
              />
            </Field>
            <div className="form-actions">
              <Button
                type="button"
                onClick={() => {
                  void run(async () => {
                    const text = await call<string | null>("importFile");
                    if (text) setImportText(text);
                  });
                }}
              >
                从文件读取
              </Button>
              <span className="grow" />
              <Button type="submit" variant="default">
                导入
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={!!details}
        onClose={() => setDetails(null)}
        title="详情与测试结果"
        wide
      >
        {details && (
          <>
            <h3>{subjects.find((n) => n.id === details)?.name}</h3>
            {data.results.filter(
              (r) =>
                r.subjectId === details &&
                r.kind === (isChain ? "chain" : "node"),
            ).length ? (
              data.results
                .filter(
                  (r) =>
                    r.subjectId === details &&
                    r.kind === (isChain ? "chain" : "node"),
                )
                .map((r) => (
                  <div className="result-detail" key={r.sourceId}>
                    <strong>
                      {r.sourceId === "local"
                        ? "Mac 本机"
                        : data.vps.find((v) => v.id === r.sourceId)?.name ||
                          r.sourceId}
                    </strong>
                    <p>
                      {r.latencyMs?.toFixed(0) ?? "—"} ms ·{" "}
                      {r.speedMBps?.toFixed(2) ?? "—"} MB/s
                    </p>
                    {r.error && <p className="error-text">{r.error}</p>}
                    {r.hops?.map((h, i) => (
                      <div key={h.nodeId} className="hop-result">
                        <Badge tone={h.state === "blocked" ? undefined : h.ok ? "good" : "bad"}>
                          第 {i + 1} 跳 · {h.state === "blocked" ? "未测试" : h.ok ? "通过" : "失败"}
                        </Badge>
                        <span>
                          {data.nodes.find((n) => n.id === h.nodeId)?.name}
                        </span>
                        <small>
                          {h.error || `${h.latencyMs?.toFixed(0)} ms`}
                        </small>
                      </div>
                    ))}
                    <small className="muted">
                      {new Date(r.testedAt).toLocaleString()}
                    </small>
                  </div>
                ))
            ) : (
              <p className="quiet">尚未测试。请在节点操作菜单中发起测试。</p>
            )}
            <div className="form-actions">
              <Confirm
                title="删除此项？"
                description={
                  isChain
                    ? "删除保存的代理链，原始节点保留。"
                    : `删除节点将影响这些链路：${
                        data.chains
                          .filter((c) => c.nodeIds.includes(details))
                          .map((c) => c.name)
                          .join("、") || "无"
                      }。确认后会同时删除受影响链路。`
                }
                onConfirm={async () => {
                  await call("delete", {
                    kind: isChain ? "chains" : "nodes",
                    id: details,
                    confirmAffected: true,
                  });
                  setDetails(null);
                }}
              >
                删除{isChain ? "链路" : "节点"}
              </Confirm>
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={!!optimizing}
        onClose={() => setOptimizing(null)}
        title="优选 IP"
        description="仅临时替换 Address，保留 Host、SNI 和协议参数。应用后只修改本机节点。"
        wide
      >
        {optimizing && (
          <>
            <Field label="候选地址，每行一个">
              <Textarea
                rows={6}
                value={addresses}
                onChange={(e) => setAddresses(e.target.value)}
              />
            </Field>
            <div className="actions">
              <Button
                onClick={() => {
                  void run(async () =>
                    setAddresses(
                      (await call<string[]>("candidateIPs")).join("\n"),
                    ),
                  );
                }}
              >
                获取 Cloudflare 候选 IP
              </Button>
              <Button
                variant="default"
                disabled={!addresses.trim()}
                onClick={() => {
                  void run(
                    async () =>
                      setOptTask(
                        await call<string>("optimize", {
                          nodeId: optimizing.id,
                          addresses: addresses.trim().split(/\s+/),
                          sourceId: displaySource,
                        }),
                      ),
                    "优选任务已加入队列",
                  );
                }}
              >
                测试真实延迟和速度
              </Button>
            </div>
            {optTask && (
              <p className="hint">
                {data.tasks.find((t) => t.id === optTask)?.state === "running"
                  ? "测试进行中…"
                  : "任务已结束"}{" "}
                · {optResults.length} 个结果
              </p>
            )}
            <div className="candidate-list">
              {[...optResults]
                .sort((a, b) => (b.speedMBps ?? -1) - (a.speedMBps ?? -1))
                .map((r) => (
                  <div className="candidate-row" key={r.address}>
                    <span>{r.address}</span>
                    <span>{r.latencyMs?.toFixed(0) ?? "—"} ms</span>
                    <span>{r.speedMBps?.toFixed(2) ?? "—"} MB/s</span>
                    {r.error ? (
                      <span className="error-text" title={r.error}>
                        失败
                      </span>
                    ) : (
                      <Button
                        onClick={() => {
                          void run(
                            () =>
                              call("applyIP", {
                                nodeId: optimizing.id,
                                address: r.address,
                              }),
                            "Address 已更新",
                          );
                        }}
                      >
                        应用
                      </Button>
                    )}
                  </div>
                ))}
            </div>
          </>
        )}
      </Modal>
        </TabsContent>
      </Tabs>
    </>
  );
}

