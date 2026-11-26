Gungun 是 macOS VPS 与代理节点管理端，fq 是配套 Linux 管理程序。

下载匹配 CPU 的 Gungun DMG，使用 SHA256SUMS 校验。fq 提供 Linux amd64 与 arm64 单文件二进制，也可以由 Gungun 经 SSH 上传安装。

支持 VPS / SSH、sing-box 六协议、Cloudflare DNS / CDN / Argo、DNS-01 证书、Caddy 网站、WARP、节点与订阅、动态聚合、多跳链式代理、多主机测速、优选 IP 和配置事务回滚。

签名 / Apple 公证取决于发布时是否配置凭据；无凭据的构建未签名、未公证。证书自动续期依赖 Mac 在线。后续跳暂不支持 Hysteria2 / TUIC UDP 拨号。Snell v6 和链路请导出 Mihomo YAML。

完整验证状态、外部条件和已知限制请阅读仓库 docs/测试报告.md 与 docs/使用说明.md。
