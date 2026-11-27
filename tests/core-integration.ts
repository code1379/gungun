import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { Benchmark } from "../apps/desktop/src/main/benchmark";
import { createCoreReadiness } from "../apps/desktop/src/main/core-readiness";
import { nodeSchema, settingsSchema, type Chain } from "../packages/domain/src/index";
import type { SSH } from "../apps/desktop/src/main/ssh";

const core = process.env.SING_BOX_BINARY || resolve(`resources/bin/sing-box-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`);
const dir = await mkdtemp(join(tmpdir(), "gungun-singbox-chain-"));
async function port() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const value = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
const ports = [await port(), await port()];
while (ports[1] === ports[0]) ports[1] = await port();
const secret = "integration-snell-secret";
const children: ReturnType<typeof spawn>[] = [];
const readiness: Awaited<ReturnType<typeof createCoreReadiness>>[] = [];
const logs = ["", ""];
let processError: Error | undefined;
const target = createServer((req, res) => {
  if (req.url === "/download") {
    res.writeHead(200, { "Content-Length": "1000000" });
    res.end(Buffer.alloc(1000000, 42));
  } else { res.writeHead(204); res.end(); }
});
await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
try {
  for (let i = 0; i < ports.length; i++) {
    const current = join(dir, String(i));
    await mkdir(current);
    const config = {
      log: { level: process.env.GUNGUN_CORE_DEBUG ? "debug" : "warn", timestamp: true },
      inbounds: [{ type: "snell", tag: "snell-in", listen: "127.0.0.1", listen_port: ports[i], psk: secret, version: 6, mode: "default" }],
      outbounds: [{ type: "direct", tag: "server-direct" }],
      route: { final: "server-direct" },
    };
    readiness.push(await createCoreReadiness(config));
    const path = join(current, "config.json");
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(core, ["run", "--disable-color", "-D", current, "-c", path], { stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk: Buffer) => {
      logs[i] = (logs[i] + chunk.toString()).slice(-12000);
      if (process.env.GUNGUN_CORE_DEBUG) console.log(`SERVER ${i + 1}: ${chunk}`);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => { processError = error; });
    children.push(child);
  }
  await Promise.all(readiness.map((probe, i) => probe.wait(() => !!processError || children[i].exitCode !== null)));
  if (processError) throw processError;
  const nodes = ports.map((value, i) => nodeSchema.parse({
    id: randomUUID(), name: `Real sing-box Snell hop ${i + 1}`, protocol: "snell",
    address: "127.0.0.1", port: value, password: secret, tagId: "integration",
  }));
  const chain: Chain = { id: randomUUID(), name: "Actual two-hop detour", nodeIds: nodes.map((node) => node.id) };
  const url = `http://127.0.0.1:${(target.address() as net.AddressInfo).port}`;
  const settings = settingsSchema.parse({ latencyUrl: url, downloadUrl: url + "/download", downloadBytes: 1000000, timeoutMs: 7000 });
  const benchmark = new Benchmark(core, {} as SSH);
  for (const node of nodes) {
    const result = await benchmark.test(node, nodes, null, settings, true);
    assert.equal(result.error, null);
    assert.ok(result.speedMBps! > 0);
  }
  const result = await benchmark.test(chain, nodes, null, settings, true);
  assert.equal(result.error, null);
  assert.equal(result.hops?.length, 2);
  assert.ok(result.hops?.every((hop) => hop.ok));
  assert.ok(result.speedMBps! > 0);
  console.log("PASS: actual Snell v6 node, sing-box detour two-hop chain, per-hop connectivity, real 1MB download");
  nodes[1].password = "wrong-second-hop-password";
  const broken = await benchmark.test(chain, nodes, null, settings, false);
  assert.ok(broken.error);
  assert.equal(broken.hops?.[0].state, "success");
  assert.equal(broken.hops?.[1].state, "failed");
  console.log("PASS: broken second-hop credentials preserve first hop success and report the failed second hop");
  nodes[1].password = secret;
  nodes[0].password = "wrong-first-hop-password";
  const upstream = await benchmark.test(chain, nodes, null, settings, false);
  assert.equal(upstream.hops?.[0].state, "failed");
  assert.equal(upstream.hops?.[1].state, "blocked");
  console.log("PASS: failed first hop leaves later hops explicitly untested");
} catch (error) {
  console.error(logs.map((log, i) => `SERVER ${i + 1}: ${log}`).join("\n"));
  throw error;
} finally {
  for (const child of children) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
      setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref();
    });
  }
  await Promise.all(readiness.map((probe) => probe.close()));
  await new Promise<void>((resolve) => target.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}

