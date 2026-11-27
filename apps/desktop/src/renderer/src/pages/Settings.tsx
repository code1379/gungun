import { useState } from "react";
import { Settings as SettingsType } from "@gungun/domain";
import { useApp } from "../api";
import { Button, Field, PageHeader, pretty, Select, Input } from "../components/ui";
export default function Settings() {
  const { data, call, run } = useApp();
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [result, setResult] = useState<unknown>(null);
  if (!data) return null;
  const values = draft || data.settings;
  const update = <K extends keyof SettingsType>(
    key: K,
    value: SettingsType[K],
  ) => setDraft({ ...values, [key]: value });
  return (
    <>
      <PageHeader
        title="设置"
        description="凭据保存在此 Mac 的本地数据库，不使用 macOS Keychain。"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await call("saveSettings", values);
            setDraft(null);
          }, "设置已保存");
        }}
      >
        <section className="section settings-section">
          <h2>外观</h2>
          <div className="form-grid">
            <Field label="应用主题" hint="保存后同步到主窗口、终端、日志和任务窗口。跟随系统时自动响应 macOS 外观变化。">
              <Select value={values.theme} onValueChange={(value) => update("theme", value as SettingsType["theme"])}>
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
            <Field label="Cloudflare 邮箱">
              <Input
                type="email"
                value={values.cloudflareEmail}
                autoComplete="off"
                onChange={(e) => update("cloudflareEmail", e.target.value)}
              />
            </Field>
            <Field label="Global API Key">
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
            onClick={() => {
              void run(async () => {
                await call("saveSettings", values);
                setResult(await call("zones"));
              }, "Cloudflare 连接成功");
            }}
          >
            保存并读取 Zone
          </Button>
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
          <Field label="默认 SSH 私钥">
            <Input
              value={values.sshKeyPath}
              onChange={(e) => update("sshKeyPath", e.target.value)}
            />
          </Field>
          <div className="toolbar">
            <Button
              type="button"
              onClick={() => {
                void run(async () => {
                  const result = await call<{
                    path: string;
                    publicKey: string;
                  }>("generateKey");
                  setResult(result);
                  setDraft({ ...values, sshKeyPath: result.path });
                }, "已生成新的 Ed25519 密钥，旧密钥保留");
              }}
            >
              生成 / 轮换主密钥
            </Button>
            <Button
              type="button"
              onClick={() => {
                void run(async () => setResult(await call("tailscale")));
              }}
            >
              检查本机 Tailscale
            </Button>
          </div>
          <p className="hint">
            新密钥需要加入远程用户的 authorized_keys。轮换不会覆盖旧私钥或现有
            SSH config。
          </p>
        </section>
        <div className="form-actions">
          <Button type="submit" variant="default">
            保存设置
          </Button>
        </div>
      </form>
      <section className="section settings-section">
        <h2>本机数据</h2>
        <p>备份包含节点凭据和 Cloudflare Key，请保存到可信位置。</p>
        <div className="toolbar">
          <Button
            onClick={() => {
              void run(() => call("exportData"), "数据已导出");
            }}
          >
            导出完整备份
          </Button>
          <Button
            onClick={() => {
              void run(() => call("importData"), "已合并导入备份");
            }}
          >
            导入备份
          </Button>
        </div>
      </section>
      {result !== null && <pre className="output">{pretty(result)}</pre>}
    </>
  );
}

