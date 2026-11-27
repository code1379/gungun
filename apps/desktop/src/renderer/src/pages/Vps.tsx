import { useState } from "react";
import { Plus, ChevronLeft, Terminal, ScrollText, RefreshCw, Pencil, Server } from "lucide-react";
import { VPS } from "@gungun/domain";
import { useApp } from "../api";
import { Badge, Button, Confirm, Empty, Field, Modal, PageHeader, pretty, Input, Select, Checkbox } from "../components/ui";
interface Zone {
  id: string;
  name: string;
  account: { id: string; name: string };
}
export default function Vps() {
  const { data, call, run } = useApp();
  const [editing, setEditing] = useState<VPS | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [test, setTest] = useState("");
  const [detail, setDetail] = useState<unknown>(null);
  if (!data) return null;
  const current = data.vps.find((v) => v.id === selected);
  const set = <K extends keyof VPS>(k: K, v: VPS[K]) =>
    setEditing((old) => (old ? { ...old, [k]: v } : old));
  return (
    <>
      <PageHeader
        title={current ? current.name : "VPS 管理"}
        description={
          current
            ? "配置与节点以这台 VPS 的 fq 数据为准。"
            : "管理 SSH 连接、公网与 NAT 主机。"
        }
        actions={
          <>
            {current && (
              <Button
                onClick={() => {
                  setSelected(null);
                  setDetail(null);
                }}
              >
                <ChevronLeft size={15} />
                所有主机
              </Button>
            )}
            <Button
              variant="default"
              onClick={() => {
                setTest("");
                void run(async () => setEditing(await call<VPS>("newVps")));
              }}
            >
              <Plus size={16} />
              添加 VPS
            </Button>
          </>
        }
      />
      {current ? (
        <>
          <div className="detail-banner">
            <div className="host-symbol">
              <Server size={25} />
            </div>
            <div className="grow">
              <h2>{current.name}</h2>
              <p>
                {current.username}@{current.address}:{current.sshPort}
              </p>
            </div>
            <Badge>{current.kind === "nat" ? "NAT VPS" : "公网 VPS"}</Badge>
            {current.tailscale && <Badge tone="blue">Tailscale</Badge>}
          </div>
          <div className="toolbar wrap">
            <Button onClick={() => setEditing(current)}>
              <Pencil size={15} />
              编辑
            </Button>
            <Button
              onClick={() => {
                void run(() =>
                  call("openWindow", { type: "terminal", id: current.id }),
                );
              }}
            >
              <Terminal size={15} />
              SSH 终端
            </Button>
            <Button
              onClick={() => {
                void run(() =>
                  call("openWindow", { type: "logs", id: current.id }),
                );
              }}
            >
              <ScrollText size={15} />
              实时日志
            </Button>
            <Button
              onClick={() => {
                void run(
                  () => call("installFq", current.id),
                  "安装任务已加入队列",
                );
              }}
            >
              安装 / 更新 fq
            </Button>
            <Button
              onClick={() => {
                void run(
                  () => call("syncVps", current.id),
                  "同步任务已加入队列",
                );
              }}
            >
              <RefreshCw size={15} />
              手动同步节点
            </Button>
            <Button
              onClick={() => {
                void run(async () =>
                  setDetail(
                    await call("remoteRead", {
                      vpsId: current.id,
                      action: "status",
                    }),
                  ),
                );
              }}
            >
              检查状态
            </Button>
            <Button
              onClick={() => {
                void run(async () =>
                  setDetail(await call("sshConfig", current.id)),
                );
              }}
            >
              生成独立 SSH config
            </Button>
          </div>
          <dl className="details">
            <dt>公网地址</dt>
            <dd>{current.publicAddress}</dd>
            <dt>跳板机</dt>
            <dd>
              {data.vps.find((v) => v.id === current.jumpId)?.name || "无"}
            </dd>
            <dt>Cloudflare Zone</dt>
            <dd>{current.zoneName || "未选择"}</dd>
            <dt>域名空间</dt>
            <dd>
              {current.namespace}
              {current.zoneName && `.${current.zoneName}`}
            </dd>
            <dt>Tunnel</dt>
            <dd>{current.tunnelId || "部署 Argo 时创建"}</dd>
          </dl>
          {detail !== null && <pre className="output">{pretty(detail)}</pre>}
          <div className="danger-zone">
            <Confirm
              title={`删除 ${current.name}？`}
              description="仅删除本机主机记录、所属节点和受影响的链路，远程服务保留。"
              onConfirm={async () => {
                await call("delete", {
                  kind: "vps",
                  id: current.id,
                  confirmAffected: true,
                });
                setSelected(null);
              }}
            >
              删除此 VPS
            </Confirm>
          </div>
        </>
      ) : data.vps.length ? (
        <div className="host-list">
          {data.vps.map((v) => (
            <button
              key={v.id}
              className="host-row interactive"
              onClick={() => setSelected(v.id)}
            >
              <div className="host-symbol">
                <Server size={21} />
              </div>
              <div className="grow">
                <strong>{v.name}</strong>
                <p>
                  {v.address}:{v.sshPort}
                </p>
              </div>
              {v.jumpId && (
                <Badge>
                  经 {data.vps.find((x) => x.id === v.jumpId)?.name}
                </Badge>
              )}
              <Badge>{v.kind === "nat" ? "NAT VPS" : "公网 VPS"}</Badge>
              <span className="muted">查看详情</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty title="还没有 VPS">
          添加主机后即可测试 SSH
          连接。连接测试失败也可以保存，稍后再配置跳板机。
        </Empty>
      )}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={
          data.vps.some((v) => v.id === editing?.id) ? "编辑 VPS" : "添加 VPS"
        }
        description="使用独立连接配置，不覆盖现有 SSH config。"
        wide
      >
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await call("saveVps", editing);
                setEditing(null);
              }, "VPS 已保存");
            }}
          >
            <div className="form-grid">
              <Field label="名称">
                <Input
                  required
                  value={editing.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>
              <Field label="主机类型">
                <Select
                  value={editing.kind}
                  onValueChange={(value) => set("kind", value as VPS["kind"])}
                >
                  <option value="public">普通公网 VPS</option>
                  <option value="nat">NAT VPS</option>
                </Select>
              </Field>
              <Field label="SSH 地址" hint="公网 IP、主机名或 Tailscale IP">
                <Input
                  required
                  value={editing.address}
                  onChange={(e) => set("address", e.target.value)}
                />
              </Field>
              <Field
                label="公网地址"
                hint="用于节点直连与 DNS 回源；NAT 填映射公网 IP"
              >
                <Input
                  required
                  value={editing.publicAddress}
                  onChange={(e) => set("publicAddress", e.target.value)}
                />
              </Field>
              <Field label="SSH 端口">
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={editing.sshPort}
                  onChange={(e) => set("sshPort", Number(e.target.value))}
                />
              </Field>
              <Field label="SSH 用户">
                <Input
                  required
                  value={editing.username}
                  onChange={(e) => set("username", e.target.value)}
                />
              </Field>
              <Field label="认证方式">
                <Select
                  value={editing.auth}
                  onValueChange={(value) => set("auth", value as VPS["auth"])}
                >
                  <option value="key">SSH 私钥</option>
                  <option value="password">密码</option>
                </Select>
              </Field>
              {editing.auth === "key" ? (
                <Field label="私钥路径">
                  <div className="input-action">
                    <Input
                      value={editing.keyPath}
                      onChange={(e) => set("keyPath", e.target.value)}
                    />
                    <Button
                      type="button"
                      onClick={() => {
                        void run(async () => {
                          const path = await call<string | null>("chooseKey");
                          if (path) set("keyPath", path);
                        });
                      }}
                    >
                      选择
                    </Button>
                  </div>
                </Field>
              ) : (
                <Field label="密码">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={editing.password}
                    onChange={(e) => set("password", e.target.value)}
                  />
                </Field>
              )}
              <Field label="跳板机">
                <Select
                  value={editing.jumpId || ""}
                  onValueChange={(value) => set("jumpId", value || null)}
                >
                  <option value="">无，直接连接</option>
                  {data.vps
                    .filter((v) => v.id !== editing.id)
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="网络">
                <label className="checkbox">
                  <Checkbox
                    
                    checked={editing.tailscale}
                    onCheckedChange={(checked) => set("tailscale", checked)}
                  />
                  使用 Tailscale 地址连接
                </label>
              </Field>
              <Field label="Cloudflare Zone">
                <div className="input-action">
                  <Select
                    value={editing.zoneId}
                    onValueChange={(value) => {
                      const z = zones.find((z) => z.id === value);
                      if (z)
                        setEditing({
                          ...editing,
                          zoneId: z.id,
                          zoneName: z.name,
                          accountId: z.account.id,
                        });
                      else
                        setEditing({
                          ...editing,
                          zoneId: "",
                          zoneName: "",
                          accountId: "",
                        });
                    }}
                  >
                    <option value="">选择 Zone</option>
                    {editing.zoneId &&
                      !zones.some((z) => z.id === editing.zoneId) && (
                        <option value={editing.zoneId}>
                          {editing.zoneName}
                        </option>
                      )}
                    {zones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    onClick={() => {
                      void run(async () =>
                        setZones(await call<Zone[]>("zones")),
                      );
                    }}
                  >
                    读取
                  </Button>
                </div>
              </Field>
              <Field label="独立域名空间">
                <Input
                  value={editing.namespace}
                  onChange={(e) => set("namespace", e.target.value)}
                />
              </Field>
            </div>
            {test && <pre className="output">{test}</pre>}
            <div className="form-actions">
              <Button
                type="button"
                onClick={() => {
                  void run(async () => {
                    if (editing.jumpId) {
                      const jump = data.vps.find(
                        (v) => v.id === editing.jumpId,
                      )!;
                      const result = await call("sshTest", jump);
                      setTest(
                        `跳板机连接成功\n${pretty(result)}\n正在连接目标…`,
                      );
                    }
                    const r = await call("sshTest", editing);
                    setTest((prev) => `${prev}\n目标连接成功\n${pretty(r)}`);
                  }, "SSH 连接成功");
                }}
              >
                测试连接
              </Button>
              <span className="grow" />
              <Button type="button" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button type="submit" variant="default">
                保存 VPS
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

