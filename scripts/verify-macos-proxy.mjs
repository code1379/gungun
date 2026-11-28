// Explicit real-system acceptance test. The caller must opt into changing one network service.
import { execFile, execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("必须在真实 Apple Silicon macOS 上运行");
if (
  !process.env.GUNGUN_APP_PATH ||
  !process.env.GUNGUN_TEST_SERVICE_ID ||
  process.env.GUNGUN_ALLOW_NETWORK_TEST !== "1"
)
  throw new Error(
    "需要 GUNGUN_APP_PATH、GUNGUN_TEST_SERVICE_ID 和 GUNGUN_ALLOW_NETWORK_TEST=1。测试将短暂修改所选活动服务并恢复，请先退出 Gungun。",
  );
const bundle = resolve(process.env.GUNGUN_APP_PATH);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
  stdio: "inherit",
});
const helper = join(bundle, "Contents/MacOS/gungun-proxy-helper");
async function request(action, extra = {}) {
  const child = execFile(helper, ["request"], {
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
  });
  child.stdin.end(JSON.stringify({ action, ...extra }));
  const result = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.once("error", reject);
    child.once("close", (code) =>
      code ? reject(new Error("helper exited")) : resolve(JSON.parse(out)),
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const id = process.env.GUNGUN_TEST_SERVICE_ID;
const before = (await request("services")).find((service) => service.id === id);
assert.ok(before?.active, "selected service must be active");
const previous = await request("status");
assert.equal(previous.enabled, false);
assert.equal(previous.conflict, false);
// This listener validates network-setting transactions only, not HTTP/SOCKS proxy traffic.
const listener = createServer((socket) => socket.destroy());
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
try {
  const started = performance.now();
  for (let cycle = 0; cycle < 3; cycle++) {
    await request("enable", { serviceId: id, port });
    const status = await request("status");
    assert.equal(status.enabled, true);
    assert.equal(status.port, port);
    await request("disable");
    const restored = (await request("services")).find(
      (service) => service.id === id,
    );
    assert.deepEqual(
      restored.proxies,
      before.proxies,
      "all original fields including PAC and bypass lists must match",
    );
  }
  await request("enable", { serviceId: id, port });
  console.log(
    "Waiting for the real daemon lease watchdog to restore network settings…",
  );
  const deadline = Date.now() + 20000;
  while ((await request("status")).enabled && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 500));
  assert.equal((await request("status")).enabled, false);
  assert.deepEqual(
    (await request("services")).find((service) => service.id === id).proxies,
    before.proxies,
  );
  console.log(
    `PASS: 3 enable/restore cycles and lease-loss recovery (${Math.round(performance.now() - started)} ms). No per-switch authorization was requested by this script.`,
  );
  console.log(
    "Still manually verify first authorization count, Wi-Fi and USB LAN separately, no proxy/manual proxy/PAC fixtures, reboot, user edits, network changes and failure rollback. This script does not count OS authorization dialogs.",
  );
} finally {
  try {
    await request("disable");
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}
