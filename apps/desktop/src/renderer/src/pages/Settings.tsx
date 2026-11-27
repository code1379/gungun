import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { Settings as SettingsType } from "@gungun/domain";
import { useApp } from "../api";
import {
  Button,
  Field,
  PageHeader,
  pretty,
  Select,
  Input,
} from "../components/ui";
interface SSHKeyStatus {
  path: string;
  privateExists: boolean;
  publicExists: boolean;
  exists: boolean;
  publicKey: string;
}
interface SSHKeyCandidate {
  path: string;
  publicKey: string;
}
export default function Settings() {
  const { data, call, run } = useApp();
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [cloudflareResult, setCloudflareResult] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [tailscaleResult, setTailscaleResult] = useState<unknown>(null);
  const [sshMessage, setSshMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<SSHKeyStatus | null>(null);
  const [rotationCandidate, setRotationCandidate] = useState<SSHKeyCandidate | null>(null);
  useEffect(() => {
    let active = true;
    void call<SSHKeyStatus>("sshKeyStatus")
      .then((status) => {
        if (active) setKeyStatus(status);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [call]);
  if (!data) return null;
  const values = draft || data.settings;
  const update = <K extends keyof SettingsType>(
    key: K,
    value: SettingsType[K],
  ) => setDraft({ ...values, [key]: value });
  const sshKeyPath = values.sshKeyPath || "~/.ssh/id_ed25519_gungun";
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
  const tailscale = tailscaleResult && typeof tailscaleResult === "object"
    ? tailscaleResult as {
        available?: boolean;
        error?: string;
        BackendState?: string;
        Self?: { HostName?: string; TailscaleIPs?: string[] };
      }
    : null;
  const tailscaleConnected = !!tailscale && tailscale.available !== false && !tailscale.error && tailscale.BackendState === "Running";
  const tailscaleTitle = !tailscale
    ? ""
    : tailscale.available === false
      ? "未检测到本机 Tailscale"
      : tailscaleConnected
        ? "Tailscale 已连接"
        : "Tailscale 已安装，但尚未连接";
  const tailscaleDescription = !tailscale
    ? ""
    : tailscale.available === false
      ? "没有找到本机 tailscale 命令。请先安装并启动 Tailscale 客户端。"
      : tailscaleConnected
        ? `${tailscale.Self?.HostName || "本机"} · ${(tailscale.Self?.TailscaleIPs || []).join("、") || "已加入 Tailnet"}`
        : tailscale.error || `当前状态：${tailscale.BackendState || "未知"}`;
  return (
    <>
      <PageHeader
        title="设置"
        description="凭据保存在此 Mac 的本地数据库，不使用 macOS Keychain。"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          runAction("save-settings", async () => {
            await call("saveSettings", values);
            setDraft(null);
          }, "设置已保存");
        }}
      >
        <section className="section settings-section">
          <h2>外观</h2>
          <div className="form-grid">
            <Field
              label="应用主题"
              hint="保存后同步到主窗口、终端、日志和任务窗口。跟随系统时自动响应 macOS 外观变化。"
            >
              <Select
                value={values.theme}
                onValueChange={(value) =>
                  update("theme", value as SettingsType["theme"])
                }
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </Select>
            </Field>
          </div>
        </section>
        <section className="section settings-section">
          <h2>Cloudflare</h2>
          <p>
            使用 Global API Key 读取 Zone、管理 DNS、Tunnel 与回源规则。Key
            不会发送到 VPS。
          </p>
          <div className="form-grid">
            <Field
              label="Cloudflare 邮箱"
              help={{
                title: "Cloudflare 账号邮箱",
                description: "填写登录 Cloudflare 控制台时使用的账号邮箱。它会与 Global API Key 一起用于本机访问 Cloudflare API。",
                url: "https://dash.cloudflare.com/",
                linkLabel: "打开 Cloudflare 控制台",
              }}
            >
              <Input
                type="email"
                value={values.cloudflareEmail}
                autoComplete="off"
                onChange={(e) => update("cloudflareEmail", e.target.value)}
              />
            </Field>
            <Field
              label="Global API Key"
              help={{
                title: "如何获取 Global API Key",
                description: "Global API Key 是 Cloudflare 账号级密钥。Gungun 当前使用它读取 Zone、管理 DNS、创建 Tunnel 和配置回源规则。密钥保存在本机，不会发送到 VPS。",
                steps: [
                  "登录 Cloudflare 控制台，点击右上角头像。",
                  "打开 My Profile（个人资料）。",
                  "进入 API Keys 页面（不要选择 API Tokens）。",
                  "在 Global API Key 一栏点击 View，完成身份验证后复制密钥。",
                  "将密钥粘贴到这里，点击「保存并读取 Zone」验证。",
                ],
                url: "https://dash.cloudflare.com/profile/api-keys",
                linkLabel: "打开 API Keys 页面",
              }}
            >
              <Input
                type="password"
                value={values.cloudflareKey}
                autoComplete="off"
                onChange={(e) => update("cloudflareKey", e.target.value)}
              />
            </Field>
            <Field
              label="Let's Encrypt 邮箱"
              hint="申请与续期证书时接受 Let's Encrypt 服务条款。"
            >
              <Input
                type="email"
                value={values.acmeEmail}
                onChange={(e) => update("acmeEmail", e.target.value)}
              />
            </Field>
          </div>
          <Button
            type="button"
            loading={pendingAction === "cloudflare"}
            disabled={pendingAction !== null}
            onClick={() => {
              setCloudflareResult(null);
              runAction("cloudflare", async () => {
                try {
                  await call("saveSettings", values);
                  const zones = await call<Array<{ id: string; name: string }>>("zones");
                  setCloudflareResult({
                    tone: "success",
                    message: `连接成功，已读取 ${zones.length} 个 Cloudflare Zone`,
                  });
                } catch (error) {
                  setCloudflareResult({
                    tone: "error",
                    message: String(error instanceof Error ? error.message : error),
                  });
                  throw error;
                }
              }, "Cloudflare 连接成功");
            }}
          >
            {pendingAction === "cloudflare" ? "正在读取 Zone…" : "保存并读取 Zone"}
          </Button>
          {cloudflareResult && (
            <div className={`inline-status-panel ${cloudflareResult.tone}`}>
              {cloudflareResult.tone === "success" ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
              <span>{cloudflareResult.message}</span>
            </div>
          )}
        </section>
        <section className="section settings-section">
          <h2>测速</h2>
          <div className="form-grid">
            <Field label="全局最大并发">
              <Input
                type="number"
                min={1}
                max={50}
                value={values.concurrency}
                onChange={(e) => update("concurrency", Number(e.target.value))}
              />
            </Field>
            <Field label="请求超时（毫秒）">
              <Input
                type="number"
                min={3000}
                max={120000}
                value={values.timeoutMs}
                onChange={(e) => update("timeoutMs", Number(e.target.value))}
              />
            </Field>
            <Field label="真连接延迟 URL">
              <Input
                type="url"
                value={values.latencyUrl}
                onChange={(e) => update("latencyUrl", e.target.value)}
              />
            </Field>
            <Field label="下载测速 URL">
              <Input
                type="url"
                value={values.downloadUrl}
                onChange={(e) => update("downloadUrl", e.target.value)}
              />
            </Field>
            <Field label="下载数据量（字节）">
              <Input
                type="number"
                min={100000}
                max={100000000}
                value={values.downloadBytes}
                onChange={(e) =>
                  update("downloadBytes", Number(e.target.value))
                }
              />
            </Field>
          </div>
        </section>
        <section className="section settings-section">
          <h2>SSH 与 Tailscale</h2>
          <Field
            label="默认 SSH 私钥"
            hint="Gungun 默认使用 Ed25519 密钥。首次添加 VPS 时使用密码登录，确认主机指纹后再到 VPS 详情安装此公钥。"
            help={{
              title: "Gungun SSH 主密钥",
              description: "Gungun 使用一把本机主密钥管理多台 VPS。私钥只保存在这台 Mac；安装操作只会把 .pub 公钥追加到远程 authorized_keys。",
              steps: [
                "在这里生成默认 Ed25519 密钥，或选择已有密钥。",
                "添加 VPS 时先使用 SSH 密码登录并核验主机指纹。",
                "进入 VPS 详情，点击「安装 SSH 主密钥」。",
                "Gungun 会实际测试密钥登录，成功后才切换认证方式。",
                "轮换密钥时先安装并验证新公钥，再切换默认密钥；旧私钥不会自动删除。",
              ],
              url: "https://www.openssh.com/manual.html",
              linkLabel: "查看 OpenSSH 文档",
            }}
          >
            <div className="input-action">
              <Input
                value={sshKeyPath}
                onChange={(e) => update("sshKeyPath", e.target.value)}
              />
              <Button
                type="button"
                loading={pendingAction === "choose-key"}
                disabled={pendingAction !== null}
                onClick={() => runAction("choose-key", async () => {
                  const path = await call<string | null>("chooseKey");
                  if (path) {
                    setDraft({ ...values, sshKeyPath: path });
                    setKeyStatus(await call<SSHKeyStatus>("sshKeyStatus", { path }));
                    setSshMessage("已切换为所选私钥，请保存设置后使用。");
                  }
                })}
              >
                选择已有密钥
              </Button>
            </div>
          </Field>
          <p className="hint">
            默认路径：~/.ssh/id_ed25519_gungun。当前状态：{keyStatus?.exists
              ? "私钥和公钥均已存在"
              : keyStatus?.privateExists || keyStatus?.publicExists
                ? "检测到不完整的密钥文件，请检查后处理"
                : "尚未生成默认密钥"}。
          </p>
          <div className="toolbar wrap">
            <Button
              type="button"
              disabled={!!keyStatus?.privateExists || !!keyStatus?.publicExists || pendingAction !== null}
              loading={pendingAction === "generate-key"}
              onClick={() => runAction("generate-key", async () => {
                const generated = await call<SSHKeyCandidate>("generateKey", { path: sshKeyPath });
                setDraft({ ...values, sshKeyPath: generated.path });
                setKeyStatus(await call<SSHKeyStatus>("sshKeyStatus", { path: generated.path }));
                setSshMessage(`默认 SSH 密钥已生成：${generated.path}`);
              }, "Gungun 默认 SSH 密钥已生成")}
            >
              {pendingAction === "generate-key" ? "正在生成…" : "生成默认密钥"}
            </Button>
            <Button
              type="button"
              disabled={!keyStatus?.exists || pendingAction !== null}
              loading={pendingAction === "rotate-key"}
              onClick={() => runAction("rotate-key", async () => {
                const candidate = await call<SSHKeyCandidate>("rotateKey", { path: sshKeyPath });
                setRotationCandidate(candidate);
                setSshMessage("轮换密钥已生成，但尚未切换默认密钥。请先将新公钥安装到 VPS。");
              }, "轮换密钥已生成；旧密钥仍在使用")}
            >
              轮换密钥
            </Button>
            <Button
              type="button"
              disabled={pendingAction !== null}
              loading={pendingAction === "tailscale"}
              onClick={() => {
                setTailscaleResult(null);
                runAction("tailscale", async () => setTailscaleResult(await call("tailscale")));
              }}
            >
              {pendingAction === "tailscale" ? "正在检测…" : "检查本机 Tailscale"}
            </Button>
            <Button
              type="button"
              disabled={pendingAction !== null}
              loading={pendingAction === "check-key"}
              onClick={() => runAction("check-key", async () => {
                setKeyStatus(await call<SSHKeyStatus>("sshKeyStatus", { path: sshKeyPath }));
                setSshMessage("本机 SSH 密钥状态检查完成。");
              })}
            >
              检查密钥
            </Button>
          </div>
          {sshMessage && <div className="inline-status-panel success"><CheckCircle2 size={16} /><span>{sshMessage}</span></div>}
          {tailscale && (
            <div className={`inline-status-panel ${tailscaleConnected ? "success" : tailscale.available === false ? "error" : "warning"}`}>
              {tailscaleConnected ? <CheckCircle2 size={16} /> : tailscale.available === false ? <AlertCircle size={16} /> : <Info size={16} />}
              <div className="inline-status-content">
                <strong>{tailscaleTitle}</strong>
                <p>{tailscaleDescription}</p>
                <details>
                  <summary>查看诊断信息</summary>
                  <pre className="output">{pretty(tailscaleResult)}</pre>
                </details>
              </div>
            </div>
          )}
          {rotationCandidate && (
            <div className="section rounded-lg border p-4">
              <h3 className="font-medium">待切换的新密钥</h3>
              <p className="hint">
                先将下面的公钥加入需要使用此密钥的 VPS 的 authorized_keys，并测试新密钥登录成功。完成后再设为默认密钥；旧私钥文件会保留。
              </p>
              <p className="mono break-all">{rotationCandidate.path}</p>
              <pre className="output">{rotationCandidate.publicKey}</pre>
              <div className="toolbar">
                <Button
                  type="button"
                  loading={pendingAction === "activate-key"}
                  disabled={pendingAction !== null}
                  onClick={() => runAction("activate-key", async () => {
                    if (!window.confirm("请确认新公钥已安装到所有需要使用它的 VPS，并且新密钥登录测试成功。继续切换默认密钥？")) return;
                    await call("activateSSHKey", { path: rotationCandidate.path });
                    setDraft({ ...values, sshKeyPath: rotationCandidate.path });
                    setKeyStatus(await call<SSHKeyStatus>("sshKeyStatus", { path: rotationCandidate.path }));
                    setRotationCandidate(null);
                    setSshMessage("默认 SSH 密钥已切换；旧私钥仍保留。");
                  }, "默认 SSH 密钥已切换；旧私钥仍保留")}
                >
                  设为默认密钥
                </Button>
                <Button type="button" onClick={() => setRotationCandidate(null)}>
                  取消
                </Button>
              </div>
            </div>
          )}
          <p className="hint">
            添加 VPS 时默认使用这里配置的密钥。轮换是独立操作，不会覆盖旧私钥；请先部署并验证新公钥，再切换默认密钥。
          </p>
        </section>
        <div className="form-actions">
          <Button type="submit" variant="default" loading={pendingAction === "save-settings"} disabled={pendingAction !== null}>
            保存设置
          </Button>
        </div>
      </form>
      <section className="section settings-section">
        <h2>本机数据</h2>
        <p>备份包含节点凭据和 Cloudflare Key，请保存到可信位置。</p>
        <div className="toolbar">
          <Button
            loading={pendingAction === "export-data"}
            disabled={pendingAction !== null}
            onClick={() => runAction("export-data", () => call("exportData"), "数据已导出")}
          >
            导出完整备份
          </Button>
          <Button
            loading={pendingAction === "import-data"}
            disabled={pendingAction !== null}
            onClick={() => runAction("import-data", () => call("importData"), "已合并导入备份")}
          >
            导入备份
          </Button>
        </div>
      </section>
    </>
  );
}
