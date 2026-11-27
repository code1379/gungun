import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const source = process.env.RELEASE_SOURCE;
const tag = process.env.RELEASE_TAG;
if (
  !/^[a-f0-9]{40}$/.test(source || "") ||
  !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag || "")
)
  throw new Error("Missing final release identity");
const linux = stripVTControlCharacters(
  readFileSync("release-assets/test-report-linux.txt", "utf8"),
);
const unitCount = linux.match(/Tests\s+(\d+)\s+passed/)?.[1];
const combinations = [
  ...linux.matchAll(
    /--- PASS: TestRealCoreSixProtocolsAndChain\/chain-matrix\//g,
  ),
].length;
const rejected = [
  ...linux.matchAll(
    /--- PASS: TestRealCoreSixProtocolsAndChain\/unsupported-chain\//g,
  ),
].length;
if (
  !unitCount ||
  combinations !== 20 ||
  rejected !== 4 ||
  !linux.includes("PASS: actual Caddy TLS reverse proxy") ||
  !linux.includes("PASS: actual systemd installation") ||
  !linux.includes("PASS: actual Snell v6 node")
)
  throw new Error("Incomplete Linux validation evidence");
for (const arch of ["arm64"]) {
  const archive = `release-assets/test-report-macos-${arch}.zip`;
  const read = (pattern) =>
    execFileSync("unzip", ["-p", archive, pattern], { encoding: "utf8" });
  if (!read("*chain-macos.txt").includes("PASS: actual Snell v6 node"))
    throw new Error(`Missing real macOS ${arch} chain evidence`);
  const dmg = read("*dmg.txt");
  if (
    !dmg.includes("Verified actual DMG install and launch") ||
    !dmg.includes("Theme smoke passed: persisted system/light/dark") ||
    !dmg.includes("Theme restart passed: saved light preference restored") ||
    !dmg.includes("Terminal theme passed: actual SSH stream survived") ||
    !dmg.includes(
      "Verified bundled native sing-box and both fq ELF architectures.",
    )
  )
    throw new Error(`Missing installed macOS ${arch} application evidence`);
}
const url = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const report = `\n\n## 本次正式发布验证\n\n版本：${tag}。源码：${source}。\n\n实际发布流水线：${url}\n\n本小节在全部平台作业成功后生成，并读取 Linux 文本报告和macOS arm64 报告核对关键通过记录。\n\n| 项目 | 本次结果 |\n| --- | --- |\n| TypeScript / 数据 / SSH 单元与集成测试 | ${unitCount} 项通过 |\n| Go race、六协议真实连接与下载 | 通过 |\n| 支持的代理链组合 | ${combinations} 组实际请求和下载通过 |\n| QUIC → VLESS 不稳定组合 | ${rejected} 组明确拒绝，未伪称实际连接通过 |\n| 独立双跳服务、认证故障与上游阻断定位 | 通过 |\n| systemd、证书安装、服务监听、回滚与 Caddy HTTPS | 通过 |\n| macOS arm64 真链路测试 | 通过 |\n| macOS arm64 DMG 构建、挂载、安装与启动 | 通过 |\n| 三种主题、nativeTheme 同步、冷启动与 SSH 会话保持 | 实际桌面与已安装 DMG 均通过 |\n| 安装包内 sing-box 原生执行、fq 两种 ELF 架构 | 通过 |\n| fq Linux amd64 / arm64 | 实际交叉编译与架构校验通过；未声称在 arm64 Linux 主机运行 |\n\nCloudflare 生产账号、实际 VPS / NAT / Tailscale 路由、WARP 注册与 Apple 签名等外部验证状态仍以前文说明为准。\n`;
writeFileSync(
  "release-assets/测试报告.md",
  readFileSync("release-assets/测试报告.md", "utf8") + report,
);
console.log(
  `Validated final report: ${unitCount} unit tests, ${combinations} real protocol chains, the installed macOS arm64 application.`,
);
