import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(resolve("apps/desktop/package.json"));
const electronEntry = require.resolve("electron");
const installScript = join(dirname(electronEntry), "install.js");
const proxy =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy;
const env = { ...process.env };

if (proxy) {
  env.ELECTRON_GET_USE_PROXY ||= "true";
  env.GLOBAL_AGENT_HTTPS_PROXY ||= proxy;
  env.GLOBAL_AGENT_HTTP_PROXY ||= proxy;
  console.log("检测到 HTTP(S) 代理，Electron 下载将通过该代理进行");
} else {
  console.log("未检测到 HTTP_PROXY / HTTPS_PROXY，Electron 将尝试直连下载");
}

const result = spawnSync(process.execPath, [installScript], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0)
  process.exit(result.status ?? 1);
