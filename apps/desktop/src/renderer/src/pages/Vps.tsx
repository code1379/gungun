import { useState } from "react";
import { Plus, ChevronLeft, Terminal, ScrollText, RefreshCw, Pencil, Server, KeyRound } from "lucide-react";
import { VPS } from "@gungun/domain";
import { useApp } from "../api";
import { Badge, Button, Confirm, Empty, Field, Modal, PageHeader, pretty, Input, Select, Checkbox } from "../components/ui";
export default function Vps() {
  const { data, call, run } = useApp();
  const [editing, setEditing] = useState<VPS | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [overridePublicAddress, setOverridePublicAddress] = useState(false);
  const [test, setTest] = useState("");
  const [detail, setDetail] = useState<unknown>(null);
  const [installingKey, setInstallingKey] = useState(false);
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
                setOverridePublicAddress(false);
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
            {current.auth === "password" ? (
              <Button
                disabled={installingKey}
                onClick={() => {
                  void run(async () => {
                    setInstallingKey(true);
                    try {
                      const result = await call("installSSHKey", { vpsId: current.id });
                      setDetail(result);
                    } finally {
                      setInstallingKey(false);
                    }
                  }, "SSH 公钥已安装并验证，已切换为密钥认证");
                }}
              >
                <KeyRound size={15} />
                {installingKey ? "正在安装密钥…" : "安装 SSH 主密钥"}
              </Button>
            ) : (
              <Badge tone="good">SSH 密钥认证已启用</Badge>
            )}
            <Button
              onClick={() => {
                setOverridePublicAddress(current.publicAddress !== current.address);
                setEditing(current);
              }}
            >
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
            <dt>域名空间</dt>
            <dd>
              {current.zoneName
                ? `${current.namespace}.${current.zoneName}`
                : `${current.namespace}（尚未绑定域名）`}
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
                  {v.address ? `${v.address}:${v.sshPort}` : "尚未填写服务器地址"}
                </p>
                <p className="muted">
                  域名空间：{v.namespace}{v.zoneName ? `.${v.zoneName}` : ""}
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
                await call("saveVps", {
                  ...editing,
                  publicAddress: overridePublicAddress ? editing.publicAddress : editing.address,
                });
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
              <Field
                label="服务器地址"
                hint="Gungun 使用此地址建立 SSH 连接；可填写公网 IP、域名或 Tailscale IP"
                help={{
                  title: "服务器地址与节点对外地址",
                  description: "服务器地址只用于 SSH 管理连接；节点对外地址用于生成代理节点和 DNS 回源地址。",
                  steps: [
                    "普通公网 VPS 通常两个地址相同。",
                    "NAT VPS 的服务器地址可填写 Tailscale IP 或跳板机可达的内网地址。",
                    "NAT VPS 的节点对外地址应填写服务商分配的公网映射 IP。",
                  ],
                }}
              >
                <Input
                  required
                  placeholder="例如 203.0.113.10"
                  value={editing.address}
                  onChange={(e) => {
                    const address = e.target.value;
                    setEditing((old) =>
                      old
                        ? {
                            ...old,
                            address,
                            publicAddress: overridePublicAddress ? old.publicAddress : address,
                          }
                        : old,
                    );
                  }}
                />
              </Field>
              <Field
                label="节点对外地址"
                hint={overridePublicAddress
                  ? "用于生成节点连接地址与 DNS 回源；NAT VPS 填运营商分配的映射公网 IP。"
                  : "默认与服务器地址相同。只有 NAT 映射或独立对外入口时才需要单独指定。"}
              >
                <div className="grid gap-3">
                  <label className="checkbox">
                    <Checkbox
                      checked={!overridePublicAddress}
                      onCheckedChange={(checked) => {
                        setOverridePublicAddress(!checked);
                        if (checked) set("publicAddress", editing.address);
                      }}
                    />
                    与服务器地址相同
                  </label>
                  {overridePublicAddress && (
                    <Input
                      required
                      placeholder="例如 NAT 映射公网 IP"
                      value={editing.publicAddress}
                      onChange={(e) => set("publicAddress", e.target.value)}
                    />
                  )}
                </div>
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
              {data.vps.some((v) => v.id === editing.id) && editing.auth === "key" ? (
                <Field label="SSH 认证">
                  <p className="hint">此主机已安装 Gungun 主密钥。密钥路径由「设置 → SSH 与 Tailscale」统一管理。</p>
                </Field>
              ) : (
                <Field
                  label="SSH 登录密码"
                  help={{
                    title: "首次 SSH 登录",
                    description: "首次添加 VPS 使用服务商提供的 SSH 密码登录。连接成功并核验主机指纹后，可以在 VPS 详情中安装本机主密钥。",
                    steps: [
                      "在服务商控制台或初始化邮件中找到 SSH 登录密码。",
                      "先使用密码测试并保存 VPS。",
                      "进入 VPS 详情，点击「安装 SSH 主密钥」。程序会把公钥追加到 authorized_keys，并实际验证密钥登录。",
                      "验证成功后，Gungun 自动切换为密钥认证并清除本地保存的 SSH 密码。",
                    ],
                  }}
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    required={editing.auth === "password"}
                    value={editing.password}
                    disabled={editing.auth === "key"}
                    placeholder={editing.auth === "key" ? "已启用密钥认证" : "输入 VPS SSH 密码"}
                    onChange={(e) => set("password", e.target.value)}
                  />
                </Field>
              )}
              <Field
                label="跳板机"
                help={{
                  title: "跳板机",
                  description: "当 Mac 无法直接连接目标 VPS 的 SSH 端口时，可选择一台已添加且能够访问目标的 VPS。Gungun 会先登录跳板机，再通过 SSH 转发连接目标。",
                }}
              >
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
              <Field
                label="网络"
                help={{
                  title: "Tailscale 连接",
                  description: "如果 SSH 地址填写的是 Tailscale IP，需要本机和 VPS 都已经加入同一个可互通的 Tailnet。此开关仅作连接方式标记，不会自动替你加入 Tailnet。",
                  url: "https://tailscale.com/kb/1017/install",
                  linkLabel: "查看 Tailscale 安装说明",
                }}
              >
                <label className="checkbox">
                  <Checkbox
                    
                    checked={editing.tailscale}
                    onCheckedChange={(checked) => set("tailscale", checked)}
                  />
                  使用 Tailscale 地址连接
                </label>
              </Field>
            </div>
            {test && <pre className="output">{test}</pre>}
            <div className="form-actions sticky bottom-[-16px] z-10 border-t border-border bg-popover py-3">
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
                    const r = await call("sshTest", {
                      ...editing,
                      publicAddress: overridePublicAddress ? editing.publicAddress : editing.address,
                    });
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

