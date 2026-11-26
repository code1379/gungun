# Gungun

macOS VPS 与代理节点管理端，以及 Linux 远程管理程序 fq。Electron / React / TypeScript / SQLite + Go Monorepo。

> 开发验证中。尚未创建正式 Release；测试安装包仅由 Actions Artifact 提供。未经实际执行的验收项目不会标为通过。

## 开发

需要 Node.js 24、pnpm 11.25.0、Go 1.25.4；打包和 DMG 验证需要真实 macOS。

```sh
pnpm install --frozen-lockfile
pnpm fq:build
pnpm cores:download
pnpm dev
```

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:go
pnpm test:integration
pnpm build
pnpm test:desktop
pnpm package:mac
```

`WITH_SINGBOX=1 pnpm cores:download` 额外下载 sing-box，供六协议实测使用。核心下载验证官方 Release 的 SHA256 digest，缺失校验值时拒绝安装。

## 功能

- 公网 / NAT VPS、SSH 私钥 / 密码、跳板机与 Tailscale 地址；独立 SSH config。
- fq 管理 sing-box 六协议，协议独立 DIRECT / WARP 出站；Caddy 网站反向代理。
- Cloudflare Global API Key 留在 Mac，管理 Zone、DNS、CDN 回源端口与每 VPS 固定 Tunnel。
- VPS 保留证书私钥，Mac 处理 Let's Encrypt DNS-01、部署和续期。
- VPS SSH 手动同步、外部订阅、手动节点、动态 Tag 聚合。
- 按原节点 ID 引用的多跳链式代理、逐跳诊断、完整链路测速与 Mihomo 导出。
- 当前 Tag 的多主机真实延迟 / 速度测试；优选 IP 只修改本机节点 Address。
- 持久化任务、远程配置备份 / 预检查 / 应用 / 验证 / 失败回滚。

## 说明与验证

- [使用说明](docs/使用说明.md)
- [开发文档](docs/开发文档.md)
- [测试报告与完整验收表](docs/测试报告.md)
- [GitHub Actions](https://github.com/code1379/gungun/actions)

Cloudflare、真实 VPS、NAT 映射、Apple 签名与公证等外部条件及验证状态见测试报告。无签名凭据时构建的是未签名应用。
