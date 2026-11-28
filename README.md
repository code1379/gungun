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

- 公网 / NAT VPS、密码首次登录后安装 SSH 主密钥、跳板机与 Tailscale 地址；独立 SSH config。
- fq 管理 sing-box 六协议，协议独立 DIRECT / WARP 出站；Caddy 网站反向代理。
- Cloudflare Global API Key 留在 Mac；部署时选择 Zone，管理 DNS、CDN 回源端口与每 VPS 固定 Tunnel。
- VPS 保留证书私钥，Mac 处理 Let's Encrypt DNS-01、部署和续期。
- VPS SSH 手动同步、外部订阅、手动节点、动态 Tag 聚合。
- 按原节点 ID 引用的多跳链式代理、逐跳诊断、完整链路测速与 Mihomo 导出。
- 当前 Tag 的多主机真实延迟 / 速度测试；优选 IP 只修改本机节点 Address。
- 持久化任务、远程配置备份 / 预检查 / 应用 / 验证 / 失败回滚。
- 字段级帮助、官方文档快捷入口与应用内帮助中心。

## 说明与验证

- [使用说明](docs/使用说明.md)
- [开发文档](docs/开发文档.md)
- [测试报告与完整验收表](docs/测试报告.md)
- [GitHub Actions](https://github.com/code1379/gungun/actions)

Cloudflare、真实 VPS、NAT 映射、Apple 签名与公证等外部条件及验证状态见测试报告。`package:mac:dir` 明确使用本地 ad-hoc 签名并校验最终应用；它不是 Developer ID 签名或 Apple 公证。正式发布仍需要配置相应凭据。


## 第一阶段：Cloudflare 与本机代理

本轮以 `unified-singbox-ui` 的 `7ec4fe9` 为基线开发。新增功能已经接入桌面应用；**真实 Cloudflare、Apple Silicon 系统代理以及原生辅助程序编译/授权仍待验收，目前不标记为最终交付完成**。

- 一级 Cloudflare 导航：账号 / Zone、DNS 查询与增删改、固定 Tunnel 与 VPS 映射和路由管理、Edge 证书查询 / 覆盖检查、Origin Rules 增删改、启停及排序。外部资源修改需要额外确认，陈旧快照拒绝覆盖；部署和资源页面共用规则与写入队列。
- 底部本机代理栏：活动节点 / ID 引用链路、sing-box 状态、启动 / 停止 / 重启、实时脱敏日志、系统代理开关。默认 mixed inbound 为 `127.0.0.1:10808`，设置中可调整；点击节点行只选中，右键设置活动节点。
- macOS 系统代理：SMAppService 特权辅助程序、受代码签名及代码哈希校验的 XPC、完整网络代理快照、写前恢复日志、心跳看护和外部修改冲突保护。开发模式可以运行本机核心并只读查看网络服务；系统代理辅助程序需要位于已签名的 `.app` 中，并在 macOS 后台项目中获准运行。首次授权与后续无重复密码的行为尚未在真机验证。

新增检查命令：

```sh
pnpm test                    # 无需核心二进制的逻辑 / 模拟进程回归
pnpm cores:download
pnpm test:local-configs      # 官方 sing-box check：六协议与四种链路配置
pnpm test:local-runtime      # 真实进程和 HTTP/SOCKS，当前 Linux 容器受 netlink 限制
pnpm test:macos-helper       # 必须在 Apple Silicon macOS 原生编译检查
pnpm test:macos-bundle       # 在 Mac 检查最终 .app 与原生产物签名，不注册或改网络
```

仅在准备真机验收时，可用 `pnpm package:mac:dir` 自动完成生产构建、资源完整性检查、本地 ad-hoc 签名及最终应用签名校验；此命令不生成 DMG、不上传资产，不提交 Apple 公证。若本机 pnpm 提示包管理器记录过期，先运行 `pnpm install --no-frozen-lockfile` 同步锁文件。`test:macos-helper` 同时检查 Swift 助手和 Objective-C++ 注册模块；注册由 Electron 主进程调用 SMAppService，打包时把模块、助手和 LaunchDaemon 放入同一个 app 并纳入签名。当前已修正注册进程、状态处理和本地签名路径，真实 Mac 注册 / 批准仍待复验。本轮没有生成安装包，也没有启动 GitHub Actions。完整实测状态、真机步骤和已知限制见[测试报告](docs/测试报告.md)。

本地 `.app` 重建前先用 ⌘Q 退出旧实例；`pnpm dev` 的输出不等于完整生产构建。`pnpm test:desktop-build` 可独立检查打包前资源，Mac 实际启动仍需单独验收。
