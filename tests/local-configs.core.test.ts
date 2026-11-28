import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import {
  nodeSchema,
  singboxConfig,
  type Protocol,
} from "../packages/domain/src/index";
const exec = promisify(execFile);
const core =
  process.env.SING_BOX_BINARY ||
  resolve(
    `resources/bin/sing-box-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`,
  );
const protocols: Protocol[] = [
  "hysteria2",
  "tuic",
  "anytls",
  "snell",
  "vless-ws",
  "vless-reality",
];
const node = (protocol: Protocol) =>
  nodeSchema.parse({
    id: randomUUID(),
    name: protocol,
    protocol,
    address: "127.0.0.1",
    port: 443,
    tagId: "test",
    uuid: randomUUID(),
    password: "syntax-only-secret",
    publicKey: randomBytes(32).toString("base64url"),
    shortId: "aabb",
    alpn: protocol === "tuic" ? ["h3"] : [],
  });
async function check(config: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "gungun-config-check-"));
  try {
    await writeFile(join(directory, "config.json"), JSON.stringify(config), {
      mode: 0o600,
    });
    await exec(
      core,
      ["check", "-D", directory, "-c", join(directory, "config.json")],
      { timeout: 10000 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
describe("sing-box 1.14.4 实际配置语法校验（不代表真实协议连接）", () => {
  it.each(protocols)("%s 转换后通过官方核心 check", async (protocol) => {
    await check(singboxConfig([node(protocol)], undefined, 10808));
  });
  it.each([
    ["snell", "snell"],
    ["anytls", "snell"],
    ["vless-ws", "anytls"],
    ["hysteria2", "anytls", "snell"],
  ] as Protocol[][])("链路 %j 配置合法并保留 detour", async (...types) => {
    const nodes = types.map(node);
    const chain = {
      id: randomUUID(),
      name: "chain",
      nodeIds: nodes.map((n) => n.id),
    };
    const config = singboxConfig(nodes, chain);
    expect(config.outbounds.at(-1)?.detour).toBe(
      `gungun-hop-${nodes.length - 1}`,
    );
    await check(config);
  });
  it("后续 UDP 拨号和已知不稳定链路明确拒绝", () => {
    for (const types of [
      ["snell", "tuic"],
      ["tuic", "vless-ws"],
      ["anytls", "hysteria2"],
    ] as Protocol[][]) {
      const nodes = types.map(node);
      expect(() =>
        singboxConfig(nodes, {
          id: randomUUID(),
          name: "bad",
          nodeIds: nodes.map((n) => n.id),
        }),
      ).toThrow();
    }
  });
});
