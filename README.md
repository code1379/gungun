# Gungun

macOS VPS 与代理节点管理端，以及 Linux 远程管理程序 fq。Electron / React / TypeScript / SQLite + Go Monorepo。

> 当前从源码运行，暂停 DMG 生成和临时 Actions Artifact 上传。macOS 面向 Apple Silicon arm64，适用于 M1 Pro 等 M 系列芯片；fq 提供 Linux amd64 / arm64。后续正式安装包须完成独立打包验收后发布。

## 开发

需要 Node.js 24、pnpm 12.23.0。**不要求预先安装 Go**：首次准备时会将 Go 1.25.4 下载到项目私有的 `.tools/go` 目录，使用 Go 官方下载元数据校验 SHA256，再交叉编译 Linux amd64 / arm64 的 fq；不会修改 macOS 全局环境。

```sh
pnpm setup:install
pnpm prepare:dev
pnpm dev
```

`pnpm setup:install` 会自动读取 HTTP_PROXY / HTTPS_PROXY 并传递给 Electron 下载器；`pnpm prepare:dev` 的 Go 与 sing-box 下载同样支持代理、进度显示和失败重试。`pnpm prepare:dev` 面向 macOS Apple Silicon，自动准备项目私有 Go、构建 Linux 双架构 fq，并下载及校验 macOS arm64 sing-box。修改 fq 源码后运行 `pnpm fq:build`；`pnpm test:go` 也会自动使用项目内 Go 工具链。

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:go
pnpm test:integration
pnpm build
pnpm test:desktop
```

当前开发阶段暂不生成 DMG。最终交付时再由 Apple Silicon macOS 环境执行正式打包、安装和启动验收。核心下载验证官方 Release 的 SHA256 digest，缺失校验值时拒绝安装。

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

