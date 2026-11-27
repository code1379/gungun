import { useState } from "react";
import { Plus, ChevronLeft, Terminal, ScrollText, RefreshCw, Pencil, Server, KeyRound, CheckCircle2, AlertCircle } from "lucide-react";
import { VPS } from "@gungun/domain";
import { errorText, useApp } from "../api";
import { Badge, Button, Confirm, Empty, Field, HelpTip, Modal, PageHeader, pretty, Input, Select, Checkbox } from "../components/ui";

type HostKeyChallenge = {
  code: "HOST_KEY_UNKNOWN" | "HOST_KEY_CHANGED";
  address: string;
  fingerprint: string;
  message: string;
};

type TestResult =
  | {
      status: "success";
      latencyMs: number;
      output: string;
      jumpSummary: string;
    }
  | { status: "failed"; message: string }
  | { status: "host-key"; challenge: HostKeyChallenge };

function parseHostKeyChallenge(error: unknown): HostKeyChallenge | null {
  const message = error instanceof Error ? error.message : String(error);
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(message.slice(start, end + 1)) as Partial<HostKeyChallenge>;
    if (
      (value.code !== "HOST_KEY_UNKNOWN" && value.code !== "HOST_KEY_CHANGED") ||
      typeof value.address !== "string" ||
      !value.address ||
      typeof value.fingerprint !== "string" ||
      !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint)
    )
      return null;
    return {
      code: value.code,
      address: value.address,
      fingerprint: value.fingerprint,
      message: typeof value.message === "string" ? value.message : "需要核验 SSH 主机指纹",
    };
  } catch {
    return null;
  }
}
export default function Vps() {
  const { data, call, run } = useApp();
  const [editing, setEditing] = useState<VPS | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [overridePublicAddress, setOverridePublicAddress] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [detail, setDetail] = useState<unknown>(null);
  const [detailLabel, setDetailLabel] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<Record<string, "connected" | "failed">>({});
  if (!data) return null;
  const current = data.vps.find((v) => v.id === selected);
  const set = <K extends keyof VPS>(k: K, v: VPS[K]) =>
    setEditing((old) => (old ? { ...old, [k]: v } : old));
  const runAction = (id: string, action: () => Promise<unknown>, success = "") => {
    void run(async () => {
      setPendingAction(id);
      try {
        await action();
      } finally {
        setPendingAction(null);
      }
    }, success);
  };
  const performConnectionTest = async () => {
    if (!editing) return;
    const target = editing;
    try {
      let jumpSummary = "";
      if (target.jumpId) {
        const jump = data.vps.find((v) => v.id === target.jumpId);
        if (!jump) throw new Error("所选跳板机不存在");
        const jumpResult = await call<{ latencyMs: number }>("sshTest", jump);
        setConnectionStatus((old) => ({ ...old, [jump.id]: "connected" }));
        jumpSummary = `跳板机 ${jump.name} ${jumpResult.latencyMs} ms`;
      }
      const result = await call<{ latencyMs: number; output: string }>("sshTest", {
        ...target,
        publicAddress: overridePublicAddress ? target.publicAddress : target.address,
      });
      setConnectionStatus((old) => ({ ...old, [target.id]: "connected" }));
      setTestResult({
        status: "success",
        latencyMs: result.latencyMs,
        output: result.output,
        jumpSummary,
      });
    } catch (error) {
      const challenge = parseHostKeyChallenge(error);
      if (challenge) {
        setTestResult({ status: "host-key", challenge });
        return;
      }
      setConnectionStatus((old) => ({ ...old, [target.id]: "failed" }));
      setTestResult({ status: "failed", message: errorText(String(error)) });
    }
  };

  const runConnectionTest = async () => {
    setTestResult(null);
    setTesting(true);
    try {
      await performConnectionTest();
    } finally {
      setTesting(false);
    }
  };

  const trustHostAndContinue = async (challenge: HostKeyChallenge) => {
    setTestResult(null);
    setTesting(true);
    try {
      await call("trustHost", {
        address: challenge.address,
        fingerprint: challenge.fingerprint,
      });
      await performConnectionTest();
    } catch (error) {
      setTestResult({ status: "failed", message: errorText(String(error)) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <PageHeader
        title={current ? current.name : "VPS 管理"}
        description={
          current
            ? "配置与节点以这台 VPS 的 fq 数据为准。"
            : "管理 SSH 连接、公网与 NAT 主机。"
        }
        leading={
          current ? (
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(null);
                setDetail(null);
              }}
            >
              <ChevronLeft size={15} />
              所有主机
            </Button>
          ) : undefined
        }
        actions={
          <Button
            variant="default"
            loading={pendingAction === "new-vps"}
            disabled={pendingAction !== null}
            onClick={() => {
              setTestResult(null);
              setOverridePublicAddress(false);
              runAction("new-vps", async () => setEditing(await call<VPS>("newVps")));
            }}
          >
            <Plus size={16} />
            添加 VPS
          </Button>
        }
      />
      {current ? (
        <>
          <div className="detail-banner">
            <div className="host-symbol">
              <Server size={25} />
            </div>
            <div className="grow">
              <h2 className="flex items-center gap-2">
                <span
                  className={`ssh-status-dot ${connectionStatus[current.id] || "unknown"}`}
                  title={
                    connectionStatus[current.id] === "connected"
                      ? "最近一次 SSH 测试成功"
                      : connectionStatus[current.id] === "failed"
                        ? "最近一次 SSH 测试失败"
                        : "尚未测试 SSH 连接"
                  }
                />
                {current.name}
              </h2>
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
                loading={pendingAction === "install-key"}
                disabled={pendingAction !== null}
                onClick={() => runAction("install-key", async () => {
                  const result = await call("installSSHKey", { vpsId: current.id });
                  setDetail(result);
                  setDetailLabel("SSH 主密钥安装与验证结果");
                }, "SSH 公钥已安装并验证，已切换为密钥认证")}
              >
                安装 SSH 主密钥
              </Button>
            ) : (
              <Badge tone="good">SSH 密钥认证已启用</Badge>
            )}
            <Button
              onClick={() => {
                setOverridePublicAddress(current.publicAddress !== current.address);
                setTestResult(null);
                setEditing(current);
              }}
            >
              <Pencil size={15} />
              编辑
            </Button>
            <Button
              loading={pendingAction === "terminal"}
              disabled={pendingAction !== null}
              onClick={() => runAction("terminal", () =>
                call("openWindow", { type: "terminal", id: current.id }),
              )}
            >
              <Terminal size={15} />
              SSH 终端
            </Button>
            <Button
              loading={pendingAction === "logs"}
              disabled={pendingAction !== null}
              onClick={() => runAction("logs", () =>
                call("openWindow", { type: "logs", id: current.id }),
              )}
            >
              <ScrollText size={15} />
              实时日志
            </Button>
            <Button
              loading={pendingAction === "install-fq"}
              disabled={pendingAction !== null}
              onClick={() => runAction("install-fq", () => call("installFq", current.id), "安装任务已加入队列")}
            >
              安装 / 更新 fq
            </Button>
            <Button
              loading={pendingAction === "sync"}
              disabled={pendingAction !== null}
              onClick={() => runAction("sync", () => call("syncVps", current.id), "同步任务已加入队列")}
            >
              <RefreshCw size={15} />
              手动同步节点
            </Button>
            <div className="inline-flex items-center gap-1">
              <Button
                loading={pendingAction === "status"}
                disabled={pendingAction !== null}
                onClick={() => runAction("status", async () => {
                  setDetail(await call("remoteRead", { vpsId: current.id, action: "status" }));
                  setDetailLabel("远程服务状态检查结果");
                })}
              >
                检查远程服务状态
              </Button>
              <HelpTip
                label="检查远程服务状态说明"
                title="检查远程服务状态"
                description="通过 SSH 在 VPS 上执行 fq status，读取 Gungun 管理的远程服务运行状态。这不是 SSH 连通性测试。"
                steps={[
                  "检查 gungun-sing-box、gungun-caddy、gungun-tunnel 和 warp-svc 的 systemd active 状态。",
                  "如果服务器安装了 Tailscale，还会尝试读取服务器端 Tailscale 状态。",
                  "如果你只想确认 SSH 是否能连接，请在添加或编辑 VPS 窗口中使用「测试连接」。",
                ]}
              />
            </div>
            <Button
              loading={pendingAction === "ssh-config"}
              disabled={pendingAction !== null}
              onClick={() => runAction("ssh-config", async () => {
                const result = await call<{
                  includeAdded: boolean;
                  sshConfigPath: string;
                  path: string;
                  alias: string;
                  command: string;
                }>("sshConfig", current.id);
                setDetail(result);
                setDetailLabel(
                  result.includeAdded
                    ? "独立 SSH config 已生成，并已添加 Include"
                    : "独立 SSH config 已生成，Include 已存在",
                );
              })}
            >
              生成独立 SSH config
            </Button>
          </div>
          {detail !== null && (
            <details className="result-disclosure">
              <summary>{detailLabel || "查看最近操作结果"}</summary>
              <pre className="output">{pretty(detail)}</pre>
            </details>
          )}
          <dl className="details">
            <dt>公网地址</dt>
            <dd>{current.publicAddress}</dd>
            <dt>跳板机</dt>
            <dd>
              {data.vps.find((v) => v.id === current.jumpId)?.name || "无"}
            </dd>
            <dt>独立域名空间标识</dt>
            <dd className="namespace-detail">
              <code className="namespace-code">{current.namespace}</code>
              <span className="muted">
                {current.zoneName
                  ? `绑定 Zone：${current.zoneName}`
                  : "尚未绑定 Cloudflare Zone"}
              </span>
            </dd>
            <dt>Tunnel</dt>
            <dd>{current.tunnelId || "部署 Argo 时创建"}</dd>
          </dl>
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
                <span className="flex items-center gap-2">
                  <span
                    className={`ssh-status-dot ${connectionStatus[v.id] || "unknown"}`}
                    title={
                      connectionStatus[v.id] === "connected"
                        ? "最近一次 SSH 测试成功"
                        : connectionStatus[v.id] === "failed"
                          ? "最近一次 SSH 测试失败"
                          : "尚未测试 SSH 连接"
                    }
                  />
                  <strong>{v.name}</strong>
                </span>
                <p>
                  {v.address ? `${v.address}:${v.sshPort}` : "尚未填写服务器地址"}
                </p>
                <p className="muted">
                  独立域名空间：{v.namespace}{v.zoneName ? `.${v.zoneName}` : ""}
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
                setPendingAction("save-vps");
                try {
                  await call("saveVps", {
                    ...editing,
                    publicAddress: overridePublicAddress ? editing.publicAddress : editing.address,
                  });
                  setEditing(null);
                } finally {
                  setPendingAction(null);
                }
              }, "VPS 已保存");
            }}
          >
            <div className="form-grid">
              <Field
                label="名称"
                hint="建议使用简短英文名称，并作为 SSH Host 别名，例如 hk、hk02、jp。重复名称会在生成配置时自动追加编号。"
              >
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
              <Field
                label="独立域名空间标识"
                hint="创建 VPS 时自动生成的 5 位随机标识，用于拼接 node.xxx.example.com 等服务域名；保存后固定，不需要手动填写。"
                help={{
                  title: "独立域名空间标识",
                  description: "Gungun 在打开「添加 VPS」表单时自动生成 5 位随机字符，例如 s2cp2。保存后该标识固定，用于区分不同 VPS 的自动生成域名。",
                }}
              >
                <Input value={editing.namespace} readOnly />
              </Field>
            </div>
            <div className="form-actions sticky bottom-[-16px] z-10 border-t border-border bg-popover py-3 vps-form-actions">
              <div className="flex w-full items-center gap-3">
                <Button
                  type="button"
                  loading={testing}
                  disabled={testing || pendingAction !== null}
                  onClick={() => {
                    void runConnectionTest();
                  }}
                >
                  {testing ? "测试中…" : "测试连接"}
                </Button>
                <span className="grow" />
                <Button type="button" disabled={testing || pendingAction !== null} onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button type="submit" variant="default" loading={pendingAction === "save-vps"} disabled={pendingAction !== null || testing}>
                  {pendingAction === "save-vps" ? "保存中…" : "保存 VPS"}
                </Button>
              </div>
              {testResult && (
                <div
                  role={testResult.status === "failed" ? "alert" : "status"}
                  className={`inline-status-panel ${
                    testResult.status === "success"
                      ? "success"
                      : testResult.status === "host-key"
                        ? "warning"
                        : "error"
                  } w-full`}
                >
                  {testResult.status === "success" ? (
                    <CheckCircle2 size={15} />
                  ) : (
                    <AlertCircle size={15} />
                  )}
                  <div className="inline-status-content">
                    {testResult.status === "success" ? (
                      <>
                        <strong>SSH 连接成功</strong>
                        <span>
                          {[testResult.jumpSummary, `目标 ${testResult.latencyMs} ms`]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {testResult.output && (
                          <details>
                            <summary>查看系统信息</summary>
                            <pre className="output">{testResult.output}</pre>
                          </details>
                        )}
                      </>
                    ) : testResult.status === "host-key" ? (
                      <>
                        <strong>
                          {testResult.challenge.code === "HOST_KEY_CHANGED"
                            ? "SSH 主机指纹发生变化"
                            : "首次连接，需要核验 SSH 主机指纹"}
                        </strong>
                        <span>{testResult.challenge.address}</span>
                        <code className="mono break-all text-foreground">
                          {testResult.challenge.fingerprint}
                        </code>
                        <p>
                          {testResult.challenge.code === "HOST_KEY_CHANGED"
                            ? "此地址已有受信任的指纹，但服务器返回了不同指纹。请先通过服务商控制台或其他可信渠道重新核验。"
                            : "请先通过服务商控制台或其他可信渠道核验此指纹。信任后，Gungun 会自动保存并重新执行 SSH 测试。"}
                        </p>
                        <div className="mt-2">
                          <Button
                            type="button"
                            variant="default"
                            disabled={testing || pendingAction !== null}
                            onClick={() => {
                              void trustHostAndContinue(testResult.challenge);
                            }}
                          >
                            {testing
                              ? "正在信任并重新测试…"
                              : testResult.challenge.code === "HOST_KEY_CHANGED"
                                ? "已核验，更新指纹并继续测试"
                                : "信任指纹并继续测试"}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <strong>SSH 连接失败</strong>
                        <span>{testResult.message}</span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

