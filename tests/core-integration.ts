import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { Benchmark } from "../apps/desktop/src/main/benchmark";
import {
  nodeSchema,
  settingsSchema,
  type Chain,
} from "../packages/domain/src/index";
import type { SSH } from "../apps/desktop/src/main/ssh";
const core =
  process.env.MIHOMO_BINARY ||
  resolve(
    `resources/bin/mihomo-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`,
  );
const dir = await mkdtemp(join(tmpdir(), "gungun-chain-integration-"));
async function port() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
const ports = [await port(), await port()];
const secret = "integration-snell-secret";
const children: ReturnType<typeof spawn>[] = [];
let processError: Error | undefined;
for (let i = 0; i < ports.length; i++) {
  const current = join(dir, String(i));
  await (await import("node:fs/promises")).mkdir(current);
  const config = {
    listeners: [
      {
        name: `in-${i}`,
        type: "snell",
        listen: "127.0.0.1",
        port: ports[i],
        psk: secret,
        version: 6,
        udp: true,
      },
    ],
    proxies: [{ name: "direct", type: "direct" }],
    rules: ["MATCH,direct"],
    "log-level": process.env.GUNGUN_CORE_DEBUG ? "debug" : "warning",
  };
  await writeFile(join(current, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  const child = spawn(
    core,
    ["-d", current, "-f", join(current, "config.json")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (process.env.GUNGUN_CORE_DEBUG) {
    child.stdout?.on("data", (b) => console.log(`SERVER ${i}: ${b}`));
    child.stderr?.on("data", (b) => console.log(`SERVER ${i}: ${b}`));
  }
  child.on("error", (e) => {
    processError = e;
  });
  children.push(child);
}
const server = createServer((req, res) => {
  if (req.url === "/download") {
    res.writeHead(200, { "Content-Length": "1000000" });
    res.end(Buffer.alloc(1000000, 42));
  } else {
    res.writeHead(204);
    res.end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
try {
  for (let i = 0; i < 100; i++) {
    if (processError) throw processError;
    const ready = await new Promise<boolean>((r) => {
      const c = net.connect(ports[0], "127.0.0.1");
      c.on("connect", () => {
        c.destroy();
        r(true);
      });
      c.on("error", () => r(false));
    });
    if (ready) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const nodes = ports.map((p, i) =>
    nodeSchema.parse({
      id: randomUUID(),
      name: `Real Snell hop ${i + 1}`,
      protocol: "snell",
      address: "127.0.0.1",
      port: p,
      password: secret,
      tagId: "integration",
    }),
  );
  const chain: Chain = {
    id: randomUUID(),
    name: "Actual two-hop chain",
    nodeIds: nodes.map((n) => n.id),
  };
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const settings = settingsSchema.parse({
    latencyUrl: url,
    downloadUrl: url + "/download",
    downloadBytes: 1000000,
    timeoutMs: 7000,
  });
  const benchmark = new Benchmark(core, {} as SSH);
  const direct = await benchmark.test(nodes[0], nodes, null, settings, true);
  assert.equal(direct.error, null);
  assert.ok(direct.speedMBps! > 0);
  const direct2 = await benchmark.test(nodes[1], nodes, null, settings, true);
  assert.equal(direct2.error, null);
  const result = await benchmark.test(chain, nodes, null, settings, true);
  assert.equal(result.error, null);
  assert.equal(result.hops?.length, 2);
  assert.ok(result.hops?.every((h) => h.ok));
  assert.ok(result.speedMBps! > 0);
  console.log(
    "PASS: actual Snell v6 node, two-hop dialer-proxy chain, per-hop connectivity, real 1MB download",
  );
  nodes[1].password = "wrong-integration-password";
  const broken = await benchmark.test(chain, nodes, null, settings, false);
  assert.ok(broken.error);
  assert.equal(broken.hops?.[0].ok, true);
  assert.equal(broken.hops?.[1].ok, false);
  console.log(
    "PASS: broken second-hop credentials produce per-hop failure, without marking first hop failed",
  );
} finally {
  for (const child of children) {
    child.kill("SIGTERM");
    await new Promise<void>((r) => {
      if (child.exitCode !== null || child.signalCode !== null) r();
      else {
        child.once("exit", () => r());
        setTimeout(() => {
          child.kill("SIGKILL");
          r();
        }, 2000).unref();
      }
    });
  }
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
}
