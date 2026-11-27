import { BookOpen, ExternalLink, KeyRound, Network, Shield, Server } from "lucide-react";
import { useApp } from "../api";
import { Button, PageHeader } from "../components/ui";

const topics = [
  {
    title: "Cloudflare API Key",
    description: "设置中填写账号邮箱和 Global API Key。登录 Cloudflare 后从头像菜单进入 My Profile → API Tokens，在 Global API Key 区域点击 View 并完成身份验证。",
    url: "https://dash.cloudflare.com/profile/api-tokens",
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
    </>
  );
}
