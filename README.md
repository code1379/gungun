# Gungun

macOS VPS 与代理节点管理端，以及 Linux 远程管理程序 fq。

## 交付约束

本仓库处于开发中，尚未发布可验收的完整应用。只有核心功能集成完成并通过验证后才创建正式版本 Tag 和 Release。测试构建仅保存为 Actions Artifact。

## 技术架构

- apps/desktop：Electron、electron-vite、React、TypeScript、Tailwind CSS、Base UI、SQLite（node:sqlite）
- packages/domain：共享数据模型、节点和代理链配置、导出与校验
- fq：Go Linux amd64 / arm64 单文件远程管理程序
- docs：完整需求、设计、使用说明、开发记录与验证报告

## 核心范围

VPS/SSH/Tailscale/跳板机；sing-box 六协议部署；Cloudflare Global API Key、DNS、CDN、Tunnel；DNS-01 泛域名证书；Caddy 网站；WARP；节点与订阅；动态聚合；按 ID 引用的多跳链式代理与 Mihomo 导出；多主机真实延迟和下载测速；优选 IP；统一持久化任务中心；备份、预检查、应用、验证与失败回滚。

Cloudflare Key 仅保留在 Mac，不传送到 VPS。VPS 是服务配置来源，手动 SSH 调用 `fq export` 同步。真实环境验证与自动化测试分别记录，不伪造凭据、安装包、测试结果或签名公证。
