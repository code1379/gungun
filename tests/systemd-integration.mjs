import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
const fq = resolve("resources/bin/fq-linux-amd64");
const run = (args, input) =>
  JSON.parse(
    execFileSync("sudo", [fq, ...args, "--json"], {
      input: input === undefined ? undefined : JSON.stringify(input),
      encoding: "utf8",
      timeout: 180000,
    }),
  );
if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("Only execute in an isolated GitHub-hosted Linux runner");
if (existsSync("/etc/gungun"))
  throw new Error("Refusing to overwrite existing /etc/gungun");
const upstream = createServer((_req, res) => {
  res.end("verified-caddy-upstream");
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
try {
  execFileSync("sudo", ["install", "-d", "-m", "755", "/usr/local/lib/gungun"]);
  for (const name of ["sing-box", "mihomo"])
    execFileSync("sudo", [
      "install",
      "-m",
      "755",
      resolve(`resources/bin/${name}-linux-amd64`),
      `/usr/local/lib/gungun/${name}`,
    ]);
  run(["install"]);
  const state = {
    schemaVersion: 1,
    hostId: "integration-host",
    kind: "public",
    publicAddress: "127.0.0.1",
    namespace: "a7k2p",
    zoneName: "example.com",
    services: [],
    websites: [],
  };
  run(["apply"], state);
  const { csr } = run(["cert", "csr"], {
    domain: "a7k2p.example.com",
    domains: [],
  });
  execFileSync("sudo", ["tee", "/etc/gungun/test.csr"], {
    input: csr,
    stdio: ["pipe", "ignore", "inherit"],
  });
  execFileSync(
    "sudo",
    [
      "openssl",
      "x509",
      "-req",
      "-in",
      "/etc/gungun/test.csr",
      "-signkey",
      "/etc/gungun/key.pem",
      "-days",
      "2",
      "-copy_extensions",
      "copy",
      "-out",
      "/etc/gungun/test-cert.pem",
    ],
    { stdio: "ignore" },
  );
  const certificate = execFileSync(
    "sudo",
    ["cat", "/etc/gungun/test-cert.pem"],
    { encoding: "utf8" },
  );
  run(["cert", "install"], { certificate });
  state.services = [
    "hysteria2",
    "tuic",
    "anytls",
    "snell",
    "vless-ws",
    "vless-reality",
  ].map((protocol) => ({
    id: protocol,
    protocol,
    port: 0,
    publicPort: 0,
    edgePort: 443,
    access: "direct",
    egress: "DIRECT",
    domain: "node.a7k2p.example.com",
    path: "/gungun",
    password: "integration-long-password",
    uuid: "6a8a09f4-4c4f-4933-978d-95eb3caf6dea",
    realityServer: "www.microsoft.com",
    realityPort: 443,
  }));
  run(["apply"], state);
  assert.equal(run(["status"]).services["gungun-sing-box"].active, true);
  assert.equal(run(["export"]).nodes.length, 6);
  const current = run(["config"]);
  const invalid = structuredClone(current);
  invalid.services.find((s) => s.protocol === "snell").port =
    upstream.address().port;
  const failure = spawnSync("sudo", [fq, "apply", "--json"], {
    input: JSON.stringify(invalid),
    encoding: "utf8",
    timeout: 180000,
  });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /rolled back/);
  assert.deepEqual(run(["config"]), current);
  assert.equal(run(["status"]).services["gungun-sing-box"].active, true);
  console.log(
    "PASS: actual systemd installation, certificate deployment, six protocols, export, listener conflict rollback, restored service health",
  );
  run(["core", "update", "caddy"]);
  current.websites = [
    {
      id: "fixture-site",
      domain: "web.a7k2p.example.com",
      target: "127.0.0.1",
      targetPort: upstream.address().port,
      upstreamTLS: false,
      access: "direct",
      port: 38443,
      publicPort: 38443,
      edgePort: 443,
    },
  ];
  run(["apply"], current);
  const response = await new Promise((resolve, reject) =>
    execFile(
      "/usr/bin/curl",
      [
        "--noproxy",
        "*",
        "--silent",
        "--show-error",
        "--fail",
        "--insecure",
        "--resolve",
        "web.a7k2p.example.com:38443:127.0.0.1",
        "https://web.a7k2p.example.com:38443",
      ],
      { timeout: 10000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  assert.equal(response, "verified-caddy-upstream");
  console.log(
    "PASS: actual Caddy TLS reverse proxy to arbitrary upstream port",
  );
} finally {
  await new Promise((r) => upstream.close(() => r()));
  try {
    run(["uninstall", "--yes", "--purge"]);
  } catch (e) {
    console.error("Cleanup:", e.message);
  }
}
