import type { Chain, ProxyNode } from "./model";
import { validateChain } from "./chains";

export function toSingBox(node: ProxyNode, tag: string): Record<string, unknown> {
  if (node.certificatePin)
    throw new Error(`${node.name}：sing-box 不支持整张证书 SHA256 指纹，不能将它当成公钥指纹或静默忽略；请使用可信证书，或调整该节点的证书验证设置`);
  if ((node.protocol.startsWith("vless") || node.protocol === "tuic") && !node.uuid)
    throw new Error(`${node.name} 缺少 UUID`);
  if (!["vless-ws", "vless-reality"].includes(node.protocol) && !node.password)
    throw new Error(`${node.name} 缺少密码`);
  const outbound: Record<string, unknown> = {
    type: node.protocol.startsWith("vless") ? "vless" : node.protocol,
    tag, server: node.address, server_port: node.port,
  };
  const tls: Record<string, unknown> = {
    enabled: true, server_name: node.sni || node.host || node.address,
    insecure: node.insecure,
  };
  if (node.alpn.length) tls.alpn = node.alpn;
  if (["anytls", "vless-ws", "vless-reality"].includes(node.protocol))
    tls.utls = { enabled: true, fingerprint: node.fingerprint || "chrome" };
  switch (node.protocol) {
    case "hysteria2":
      outbound.password = node.password;
      outbound.tls = tls;
      if (node.obfs) outbound.obfs = { type: node.obfs, password: node.obfsPassword };
      break;
    case "tuic":
      outbound.uuid = node.uuid;
      outbound.password = node.password;
      outbound.congestion_control = "bbr";
      if (!node.alpn.length) tls.alpn = ["h3"];
      outbound.tls = tls;
      break;
    case "anytls":
      outbound.password = node.password;
      outbound.tls = tls;
      break;
    case "snell":
      if (new TextEncoder().encode(node.password).length < 12 || new TextEncoder().encode(node.password).length > 255)
        throw new Error(`${node.name}：Snell v6 PSK 必须为 12–255 字节`);
      outbound.version = 6;
      outbound.psk = node.password;
      outbound.mode = node.snellMode;
      break;
    case "vless-ws":
      outbound.uuid = node.uuid;
      if (node.tls) outbound.tls = tls;
      outbound.transport = { type: "ws", path: node.path || "/", headers: { Host: node.host || node.sni || node.address } };
      break;
    case "vless-reality":
      if (!node.publicKey) throw new Error(`${node.name} 缺少 Reality 公钥`);
      outbound.uuid = node.uuid;
      outbound.flow = "xtls-rprx-vision";
      tls.reality = { enabled: true, public_key: node.publicKey, short_id: node.shortId };
      outbound.tls = tls;
      break;
  }
  return outbound;
}

// Internal runtime configuration only. The subscription export UI remains
// V2Ray Base64 / Mihomo YAML and does not expose sing-box JSON exports.
export function singboxConfig(nodes: ProxyNode[], chain?: Chain, port = 10808) {
  const ordered = chain ? validateChain(chain, nodes) : nodes;
  if (!ordered.length || (!chain && ordered.length !== 1))
    throw new Error("每个测速进程需要一个节点或一条代理链");
  const outbounds = ordered.map((node, index) => {
    const outbound = toSingBox(node, `gungun-hop-${index + 1}`);
    if (index > 0) outbound.detour = `gungun-hop-${index}`;
    return outbound;
  });
  return {
    log: { level: "warn", timestamp: true },
    dns: { servers: [{ type: "local", tag: "local" }] },
    inbounds: [{ type: "mixed", tag: "gungun-benchmark", listen: "127.0.0.1", listen_port: port }],
    outbounds,
    route: { default_domain_resolver: "local", final: `gungun-hop-${ordered.length}` },
  };
}
