Gungun v1.0.0 是 macOS VPS 与代理节点管理端，fq 是配套 Linux 管理程序。

本次 macOS 仅提供 Apple Silicon arm64 DMG，适用于 M1 Pro 及其他 M 系列芯片；不提供 Intel 安装包。fq 提供 Linux amd64 / arm64 单文件程序。

包含 VPS / SSH / 跳板、sing-box 六协议、Cloudflare DNS / CDN / Argo、DNS-01 证书、Caddy 网站、WARP、节点与订阅、动态聚合、独立链式代理 Tag、多主机测速、优选 IP、持久化任务与配置失败回滚。链路通过原始节点 ID 引用，Mihomo YAML 保留 dialer-proxy 关系。

流水线验证 38 项 TypeScript / 数据 / SSH 测试、Go race、六协议真实请求、24 组链路组合、macOS 实际双跳、systemd / Caddy / 回滚，以及 DMG 挂载、安装、启动和包内核心资源。发布附带实际日志、完整测试报告、使用说明、开发文档和 SHA256SUMS。

Cloudflare 生产账号、真实 VPS / NAT / Tailscale 路由和 WARP 注册需要实际凭据与网络条件，未冒充已在用户环境验证。未配置 Apple 签名与公证凭据时，构建未签名、未公证。证书自动续期依赖 Mac 在线。后续跳不支持 Hysteria2 / TUIC UDP 拨号；Snell v6 和代理链请导出 Mihomo YAML。

先对照 SHA256SUMS 校验下载；安装与首次配置详见使用说明。
