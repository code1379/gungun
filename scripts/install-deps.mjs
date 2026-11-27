import { spawnSync } from "node:child_process";

const proxy =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy;
const env = { ...process.env, NODE_USE_ENV_PROXY: "1" };
if (proxy) {
  env.ELECTRON_GET_USE_PROXY = "true";
  env.GLOBAL_AGENT_HTTPS_PROXY = proxy;
  env.GLOBAL_AGENT_HTTP_PROXY = proxy;
  console.log("检测到代理，pnpm 与 Electron 安装脚本将使用当前代理");
}
const result = spawnSync("pnpm", ["install", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
