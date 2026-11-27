import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { randomUUID } from "node:crypto";
import {
  chainProxies,
  exportBase64,
  exportMihomo,
  nodeSchema,
  parseSubscription,
  resolveTag,
  serviceSchema,
  shareLink,
  singboxConfig,
  toSingBox,
  validateChain,
  validateVpsGraph,
  vpsSchema,
  type Chain,
  type Tag,
} from "../packages/domain/src/index";
const node = (protocol = "vless-ws", overrides = {}) =>
  nodeSchema.parse({
    id: randomUUID(),
    name: "测试节点",
    protocol,
    address: "127.0.0.1",
    port: 443,
    uuid: randomUUID(),
    password: "long-test-password",
    tagId: "manual",
    host: "node.example.com",
    sni: "node.example.com",
    path: "/test",
    ...overrides,
  });
const chain = (ids: string[]): Chain => ({
  id: randomUUID(),
  name: "HK → US",
  nodeIds: ids,
});
describe("sing-box 执行配置", () => {
  it("detour 逐跳连接并读取引用节点的最新地址", () => {
    const nodes = [node("hysteria2"), node("anytls"), node("snell")];
    const c = chain(nodes.map((n) => n.id));
    nodes[1].address = "updated.example.com";
    const config = singboxConfig(nodes, c, 12345);
    expect(config.outbounds.map((n) => n.detour)).toEqual([
      undefined,
      "gungun-hop-1",
      "gungun-hop-2",
    ]);
    expect(config.outbounds[1].server).toBe("updated.example.com");
    expect(config.route.final).toBe("gungun-hop-3");
    expect(config.inbounds[0].listen_port).toBe(12345);
  });
  it("不把整张证书指纹静默丢弃或误用为 SPKI 指纹", () => {
    expect(() =>
      toSingBox(node("hysteria2", { certificatePin: "ab".repeat(32) }), "test"),
    ).toThrow("整张证书");
  });
  it("保留 WS Host、TLS SNI 和路径，Reality 使用独立参数", () => {
    const ws = toSingBox(node("vless-ws", { tls: true }), "ws");
    expect(ws.transport).toMatchObject({
      type: "ws",
      path: "/test",
      headers: { Host: "node.example.com" },
    });
    expect(ws.tls).toMatchObject({ server_name: "node.example.com" });
    const reality = toSingBox(
      node("vless-reality", { publicKey: "public-key", shortId: "aabb" }),
      "reality",
    );
    expect(reality.transport).toBeUndefined();
    expect(reality.tls).toMatchObject({
      reality: { enabled: true, public_key: "public-key", short_id: "aabb" },
    });
  });
});
describe("链式代理模型与 Mihomo 配置", () => {
  it("按顺序拨号，最终规则选择最后一跳", () => {
    const nodes = [node(), node("anytls"), node("snell")];
    const c = chain(nodes.map((n) => n.id));
    const proxies = chainProxies(c, nodes);
    expect(proxies[0]["dialer-proxy"]).toBeUndefined();
    expect(proxies[1]["dialer-proxy"]).toBe(proxies[0].name);
    expect(proxies[2]["dialer-proxy"]).toBe(proxies[1].name);
    const yaml = parse(exportMihomo(nodes, [c]));
    expect(yaml["proxy-groups"][0].proxies).toContain(proxies[2].name);
  });
  it("链路 Tag 导出不包含无关节点凭据", () => {
    const nodes = [
      node(),
      node(),
      node("anytls", { password: "unrelated-secret" }),
    ];
    const output = exportMihomo(nodes, [
      chain(nodes.slice(0, 2).map((n) => n.id)),
    ]);
    expect(output).not.toContain("unrelated-secret");
    expect(parse(output).proxies).toHaveLength(2);
  });
  it("原节点修改后，链路读取最新参数", () => {
    const nodes = [node(), node()];
    const c = chain(nodes.map((n) => n.id));
    nodes[1].port = 8443;
    expect(chainProxies(c, nodes)[1].port).toBe(8443);
  });
  it("拒绝缺失引用、重复节点和后续 UDP 拨号", () => {
    const a = node(),
      b = node("tuic");
    expect(() => validateChain(chain([a.id, b.id]), [a, b])).toThrow("UDP");
    expect(() => validateChain(chain([a.id, "gone"]), [a])).toThrow("已删除");
    expect(() => validateChain(chain([a.id, a.id]), [a])).toThrow("重复");
    expect(validateChain(chain([b.id, a.id]), [a, b])).toHaveLength(2);
  });
  it("拒绝把链路导出成普通分享链接", () => {
    expect(() => exportBase64([node()], true)).toThrow("无法表达");
    expect(() => shareLink(node("snell"))).toThrow("Mihomo");
  });
});
describe("订阅与动态聚合", () => {
  for (const protocol of [
    "hysteria2",
    "tuic",
    "anytls",
    "vless-ws",
    "vless-reality",
  ])
    it(`${protocol} 分享往返保留关键字段和 IPv6`, () => {
      const n = node(protocol, {
        address: "2001:db8::1",
        publicKey: "test-public-key",
        shortId: "1234abcd",
        insecure: true,
      });
      const [out] = parseSubscription(
        Buffer.from(shareLink(n)).toString("base64"),
        "target",
        randomUUID,
      );
      expect(out.protocol).toBe(n.protocol);
      expect(out.address).toBe(n.address);
      expect(out.port).toBe(n.port);
      expect(out.sni).toBe(n.sni);
      expect(out.insecure).toBe(true);
      if (protocol.startsWith("vless")) expect(out.uuid).toBe(n.uuid);
      else expect(out.password).toBe(n.password);
    });
  it("聚合只按引用映射，新增和删除自动反映", () => {
    const a = node(),
      b = node("snell", { tagId: "vps" });
    const tags: Tag[] = [
      { id: "manual", name: "手动", kind: "manual", tagIds: [], url: "" },
      { id: "vps", name: "VPS", kind: "vps", tagIds: [], url: "" },
      {
        id: "aggregate",
        name: "聚合",
        kind: "aggregate",
        tagIds: ["manual", "vps"],
        url: "",
      },
    ];
    expect(resolveTag("aggregate", [a, b], tags)).toEqual([a, b]);
    expect(resolveTag("aggregate", [b], tags)).toEqual([b]);
    expect(resolveTag("all", [a, b], tags)).toEqual([a, b]);
  });
  it("拒绝聚合循环、VLESS ENC 和扁平化 dialer-proxy", () => {
    const tags: Tag[] = [
      { id: "a", name: "a", kind: "aggregate", tagIds: ["b"], url: "" },
      { id: "b", name: "b", kind: "aggregate", tagIds: ["a"], url: "" },
    ];
    expect(() => resolveTag("a", [], tags)).toThrow("循环");
    expect(() =>
      parseSubscription(
        `vless://${randomUUID()}@example.com:443?type=ws&encryption=mlkem`,
        "x",
        randomUUID,
      ),
    ).toThrow("ENC");
    expect(() =>
      parseSubscription(
        "proxies:\n- {name: chain, type: vless, dialer-proxy: first}",
        "x",
        randomUUID,
      ),
    ).toThrow("扁平化");
  });
  it("六种协议均支持 Mihomo YAML 导出导入", () => {
    const nodes = [
      "hysteria2",
      "tuic",
      "anytls",
      "snell",
      "vless-ws",
      "vless-reality",
    ].map((p) => node(p));
    const parsed = parseSubscription(exportMihomo(nodes), "target", randomUUID);
    expect(parsed.map((n) => n.protocol)).toEqual(nodes.map((n) => n.protocol));
    expect(parsed[3].password).toBe(nodes[3].password);
  });
});
it("不能把 Snell v4 或 Reality WS 静默转换", () => {
  expect(() =>
    parseSubscription(
      "proxies:\n- {name: old, type: snell, version: 4, server: localhost, port: 12345, psk: password}",
      "tag",
      randomUUID,
    ),
  ).toThrow("Snell v6");
  expect(() =>
    parseSubscription(
      `vless://${randomUUID()}@localhost:443?security=reality&type=ws`,
      "tag",
      randomUUID,
    ),
  ).toThrow("TCP");
});
it("Hysteria2 导入导出保留固定证书指纹与 Salamander", () => {
  const n = node("hysteria2", {
    certificatePin: "ab".repeat(32),
    obfs: "salamander",
    obfsPassword: "obfs-secret",
  });
  const [out] = parseSubscription(shareLink(n), "target", randomUUID);
  expect(out.certificatePin).toBe(n.certificatePin);
  expect(out.obfsPassword).toBe("obfs-secret");
  const [fromYAML] = parseSubscription(exportMihomo([n]), "target", randomUUID);
  expect(fromYAML.certificatePin).toBe(n.certificatePin);
  expect(fromYAML.obfs).toBe("salamander");
});
describe("能力与连接校验", () => {
  it("仅 WS 可以选择 CDN/Argo，拒绝不支持的 Edge 端口", () => {
    const s = {
      id: "hy2",
      protocol: "hysteria2",
      port: 0,
      publicPort: 0,
      access: "cdn",
    };
    expect(serviceSchema.safeParse(s).success).toBe(false);
    expect(
      serviceSchema.safeParse({ ...s, protocol: "vless-ws", edgePort: 8880 })
        .success,
    ).toBe(false);
    expect(
      serviceSchema.safeParse({ ...s, protocol: "vless-ws", edgePort: 8443 })
        .success,
    ).toBe(true);
  });
  it("检测 SSH 跳板机循环和缺失引用", () => {
    const a = vpsSchema.parse({
      id: randomUUID(),
      name: "HK",
      kind: "public",
      address: "localhost",
      publicAddress: "127.0.0.1",
      username: "root",
      auth: "key",
      namespace: "a7k2p",
    });
    const b = { ...a, id: randomUUID(), jumpId: a.id };
    expect(() => validateVpsGraph([{ ...a, jumpId: b.id }, b])).toThrow("循环");
    expect(() => validateVpsGraph([b])).toThrow("不存在");
  });
});
it("TLS 通配符只覆盖一层子域名", async () => {
  const { matchesDNSName } = await import("../packages/domain/src/index");
  expect(matchesDNSName("*.example.com", "node.example.com")).toBe(true);
  expect(matchesDNSName("*.example.com", "node.ns.example.com")).toBe(false);
  expect(matchesDNSName("*.ns.example.com", "node.ns.example.com")).toBe(true);
  expect(matchesDNSName("*.example.com", "example.com")).toBe(false);
});
