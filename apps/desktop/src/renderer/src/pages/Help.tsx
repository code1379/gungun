import { BookOpen, ExternalLink, KeyRound, Network, Shield, Server } from "lucide-react";
import { useApp } from "../api";
import { Button, PageHeader } from "../components/ui";

const topics = [
  {
    title: "Cloudflare API Key",
    description: "设置中填写账号邮箱和 Global API Key。登录 Cloudflare 后进入 My Profile → API Keys，在 Global API Key 一栏点击 View 并完成身份验证；不要创建 API Token。",
    url: "https://dash.cloudflare.com/profile/api-keys",
    label: "获取 Global API Key",
    icon: Shield,
  },
  {
    title: "SSH 首次登录与密钥",
    description: "首次添加 VPS 使用密码登录。核验主机指纹后，在 VPS 详情点击安装 SSH 主密钥。Gungun 会安装公钥并验证密钥登录，成功后才切换认证方式。",
    url: "https://www.openssh.com/manual.html",
    label: "OpenSSH 官方文档",
    icon: KeyRound,
  },
  {
    title: "Tailscale 网络",
    description: "本机和 VPS 必须加入同一个可互通的 Tailnet。SSH 地址可以填写 VPS 的 Tailscale IP；Gungun 不会自动加入 Tailnet。",
    url: "https://tailscale.com/kb/1017/install",
    label: "Tailscale 安装说明",
    icon: Network,
  },
  {
    title: "Cloudflare CDN 与 Argo",
    description: "CDN 使用 Cloudflare 代理回源；Argo Tunnel 由 cloudflared 建立出站隧道，不要求 VPS 开放 80 / 443 入站。两者都需要先配置 Cloudflare Zone。",
    url: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
    label: "Cloudflare Tunnel 文档",
    icon: Server,
  },
  {
    title: "Let's Encrypt DNS-01",
    description: "Gungun 通过 Cloudflare DNS API 创建 DNS-01 TXT 记录来签发证书。续期依赖 Mac 在线且能通过 SSH 访问对应 VPS。",
    url: "https://letsencrypt.org/docs/challenge-types/",
    label: "DNS-01 验证说明",
    icon: BookOpen,
  },
];

export default function Help() {
  const { call, run } = useApp();
  return (
    <>
      <PageHeader
        title="帮助与文档"
        description="常见配置说明、首次使用流程与官方文档入口。"
      />
      <div className="grid gap-3">
        {topics.map((topic) => (
          <section className="section flex flex-col gap-3" key={topic.title}>
            <div className="flex items-center gap-2">
              <topic.icon size={18} />
              <h2>{topic.title}</h2>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{topic.description}</p>
            <div>
              <Button type="button" onClick={() => {
                void run(() => call("openExternal", topic.url), "已在默认浏览器中打开官方页面");
              }}>
                <ExternalLink size={14} />
                {topic.label}
              </Button>
            </div>
          </section>
        ))}
      </div>

      <section className="section mt-4 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Network size={18} />
          <h2>Cloudflare CDN：Edge、Origin Rule 与 NAT 端口</h2>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          这三个端口属于不同网络层。Cloudflare Edge 接收客户端请求；Origin Rule
          只负责把请求转到 VPS 的公网映射端口；NAT 服务商再把公网端口转发到 VPS
          内部 sing-box 的实际监听端口。
        </p>

        <div className="rounded-xl border border-border bg-muted/20 p-4">
          <div className="mx-auto flex max-w-xl flex-col items-center gap-2 text-center">
            <div className="w-full rounded-lg border border-border bg-card p-3">
              <strong className="block text-sm">客户端</strong>
              <strong className="mt-1 block text-lg">HTTPS :2053</strong>
              <span className="text-xs text-muted-foreground">Cloudflare Edge 端口</span>
            </div>
            <span className="text-muted-foreground">↓</span>
            <span className="rounded-full bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-600 dark:text-sky-400">
              Origin Rule：目标端口改为 18880
            </span>
            <span className="text-muted-foreground">↓</span>
            <div className="w-full rounded-lg border border-border bg-card p-3">
              <strong className="block text-sm">VPS 公网映射</strong>
              <strong className="mt-1 block text-lg">:18880</strong>
              <span className="text-xs text-muted-foreground">NAT 服务商分配的公网端口</span>
            </div>
            <span className="text-muted-foreground">↓</span>
            <span className="text-xs text-muted-foreground">NAT 端口转发：18880 → 45516</span>
            <span className="text-muted-foreground">↓</span>
            <div className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
              <strong className="block text-sm">VPS 内部 sing-box</strong>
              <strong className="mt-1 block text-lg text-emerald-600 dark:text-emerald-400">:45516</strong>
              <span className="text-xs text-muted-foreground">实际监听端口</span>
            </div>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-border p-3">
            <strong className="text-sm">Edge 端口</strong>
            <p className="mt-1 text-sm text-muted-foreground">客户端访问 Cloudflare 使用的端口，例如 HTTPS 2053 或 HTTP 8080。</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <strong className="text-sm">公网映射端口</strong>
            <p className="mt-1 text-sm text-muted-foreground">Cloudflare 回源到 VPS 公网时使用的端口。NAT VPS 由服务商映射分配。</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <strong className="text-sm">内部监听端口</strong>
            <p className="mt-1 text-sm text-muted-foreground">sing-box 在 VPS 内部真正监听的端口。NAT 转发最终到达这里。</p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 pr-3 font-medium">配置项</th>
                <th className="py-2 font-medium">默认值或行为</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border"><td className="py-2 pr-3">Cloudflare Edge</td><td className="py-2">HTTPS 默认 443；HTTP 默认 80</td></tr>
              <tr className="border-b border-border"><td className="py-2 pr-3">内部监听端口</td><td className="py-2">用户填写，例如 45516</td></tr>
              <tr className="border-b border-border"><td className="py-2 pr-3">公网映射端口</td><td className="py-2">默认等于内部端口；NAT 不同时开启单独填写</td></tr>
              <tr className="border-b border-border"><td className="py-2 pr-3">Origin Rule</td><td className="py-2">Edge 端口与公网映射端口不同时，目标端口改为公网映射端口</td></tr>
              <tr><td className="py-2 pr-3">NAT 转发</td><td className="py-2">由服务商将公网映射端口转发到内部监听端口</td></tr>
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-border p-3">
          <strong className="text-sm">Origin Rule 判断条件</strong>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Edge 端口与 VPS 公网映射端口相同：不创建端口覆盖规则。</li>
            <li>Edge 端口与 VPS 公网映射端口不同：自动创建 Origin Rule，目标端口指向 VPS 公网映射端口。</li>
            <li>NAT 内部端口转换由 NAT 服务商处理；Cloudflare 不直接访问 VPS 内部端口。</li>
          </ul>
        </div>

        <div className="rounded-lg border border-border p-3">
          <strong className="text-sm">HTTP / HTTPS 与端口选择</strong>
          <p className="mt-1 text-sm text-muted-foreground">
            这里选择的是客户端到 Cloudflare 的协议，不改变 VPS 内部监听端口。HTTPS 默认 443，
            HTTP 默认 80；切换协议时 Gungun 会同步切换默认 Edge 端口。
            HTTP 模式下，VPS 源站仍由 Gungun 配置 TLS 监听，Cloudflare Zone 的 SSL/TLS
            模式应配置为 Full 或 Full (strict)，不要用 Flexible 代替源站 HTTPS。
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <p className="text-sm"><strong>HTTP：</strong><span className="text-muted-foreground">80、8080、8880、2052、2082、2086、2095</span></p>
            <p className="text-sm"><strong>HTTPS：</strong><span className="text-muted-foreground">443、2053、2083、2087、2096、8443</span></p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => {
            void run(() => call("openExternal", "https://developers.cloudflare.com/fundamentals/reference/network-ports/"), "已打开 Cloudflare 支持端口文档");
          }}>
            <ExternalLink size={14} /> Cloudflare 支持端口
          </Button>
          <Button type="button" variant="outline" onClick={() => {
            void run(() => call("openExternal", "https://developers.cloudflare.com/rules/origin-rules/"), "已打开 Cloudflare Origin Rules 文档");
          }}>
            <ExternalLink size={14} /> Cloudflare Origin Rules
          </Button>
        </div>
      </section>
    </>
  );
}
