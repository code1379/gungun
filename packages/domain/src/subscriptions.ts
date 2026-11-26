import { parse, stringify } from "yaml";
import { nodeSchema, type ProxyNode } from "./model";
export function shareLink(n: ProxyNode) {
  if (n.protocol === "snell")
    throw new Error("Snell v6 无标准 V2Ray 分享格式，请导出 Mihomo YAML");
  const scheme = n.protocol.startsWith("vless") ? "vless" : n.protocol;
  const u = new URL(`${scheme}://placeholder`);
  u.hostname = n.address.includes(":") ? `[${n.address}]` : n.address;
  u.port = String(n.port);
  u.username =
    n.protocol.startsWith("vless") || n.protocol === "tuic"
      ? n.uuid
      : n.password;
  if (n.protocol === "tuic") u.password = n.password;
  const p = u.searchParams;
  p.set("sni", n.sni || n.address);
  if (n.insecure) p.set("allowInsecure", "1");
  if (n.protocol.startsWith("vless")) {
    p.set("encryption", "none");
    p.set(
      "security",
      n.protocol === "vless-reality" ? "reality" : n.tls ? "tls" : "none",
    );
    p.set("type", n.protocol === "vless-ws" ? "ws" : "tcp");
    if (n.protocol === "vless-ws") {
      p.set("host", n.host);
      p.set("path", n.path);
    } else {
      p.set("pbk", n.publicKey);
      p.set("sid", n.shortId);
      p.set("flow", "xtls-rprx-vision");
      p.set("fp", n.fingerprint);
    }
  }
  if (n.certificatePin) p.set("pinSHA256", n.certificatePin);
  if (n.protocol === "hysteria2" && n.obfs) {
    p.set("obfs", n.obfs);
    p.set("obfs-password", n.obfsPassword);
  }
  if (n.alpn.length) p.set("alpn", n.alpn.join(","));
  u.hash = n.name;
  return u.toString();
}
export function exportBase64(nodes: ProxyNode[], hasChains = false) {
  if (hasChains)
    throw new Error("V2Ray Base64 无法表达代理链，请导出 Mihomo YAML");
  return Buffer.from(nodes.map(shareLink).join("\n")).toString("base64");
}
export function parseSubscription(
  input: string,
  tagId: string,
  makeId: () => string,
): ProxyNode[] {
  let text = input.trim();
  if (!text.includes("://") && !text.includes("proxies:")) {
    try {
      text = Buffer.from(text, "base64").toString("utf8");
    } catch {
      throw new Error("无效 Base64 订阅");
    }
  }
  if (text.includes("proxies:")) {
    const data = parse(text, { maxAliasCount: 30 }) as {
      proxies?: Record<string, unknown>[];
    };
    if (!Array.isArray(data.proxies)) throw new Error("YAML 缺少 proxies");
    return data.proxies.map((p) => fromMihomo(p, tagId, makeId()));
  }
  const lines = text.split(/\r?\n/).filter((s) => s.trim());
  if (!lines.length) throw new Error("订阅为空");
  return lines.map((line) => {
    const u = new URL(line.trim());
    const p = u.searchParams;
    const proto = u.protocol.slice(0, -1);
    if (!["vless", "hysteria2", "hy2", "tuic", "anytls"].includes(proto))
      throw new Error(`不支持协议 ${proto}`);
    if (
      proto === "vless" &&
      p.get("encryption") &&
      !["none", ""].includes(p.get("encryption")!)
    )
      throw new Error("不支持 VLESS ENC，请使用普通 VLESS");
    const protocol =
      proto === "vless"
        ? p.get("security") === "reality"
          ? "vless-reality"
          : "vless-ws"
        : proto === "hy2"
          ? "hysteria2"
          : proto;
    if (proto === "vless" && protocol === "vless-ws" && p.get("type") !== "ws")
      throw new Error("当前仅支持 VLESS WS 或 Reality");
    if (
      proto === "vless" &&
      protocol === "vless-reality" &&
      p.get("type") &&
      !["tcp", "raw"].includes(p.get("type")!)
    )
      throw new Error("当前 Reality 仅支持 TCP，不能静默转换其他传输");
    return nodeSchema.parse({
      id: makeId(),
      name: decodeURIComponent(u.hash.slice(1)) || `${protocol}-${u.hostname}`,
      protocol,
      address: u.hostname.replace(/^\[|\]$/g, ""),
      port: Number(u.port) || 443,
      uuid: ["vless", "tuic"].includes(proto)
        ? decodeURIComponent(u.username)
        : "",
      password:
        proto === "tuic"
          ? decodeURIComponent(u.password)
          : proto === "vless"
            ? ""
            : decodeURIComponent(u.username),
      sni: p.get("sni") || p.get("peer") || u.hostname,
      tls: p.get("security") !== "none",
      insecure: ["1", "true"].includes(
        p.get("allowInsecure") ||
          p.get("insecure") ||
          p.get("allow_insecure") ||
          "",
      ),
      host: p.get("host") || "",
      path: p.get("path") || "/",
      publicKey: p.get("pbk") || "",
      shortId: p.get("sid") || "",
      fingerprint: p.get("fp") || "chrome",
      certificatePin: p.get("pinSHA256") || "",
      obfs: p.get("obfs") || "",
      obfsPassword: p.get("obfs-password") || "",
      alpn: p.get("alpn")?.split(",") || [],
      tagId,
      source: "subscription",
    });
  });
}
function fromMihomo(
  p: Record<string, unknown>,
  tagId: string,
  id: string,
): ProxyNode {
  if (p["dialer-proxy"])
    throw new Error(
      "含 dialer-proxy 的订阅不能扁平化为普通节点，请使用链式代理模块",
    );
  const type = String(p.type);
  if (type === "snell" && Number(p.version) !== 6)
    throw new Error("当前仅支持 Snell v6，不能转换其他版本");
  if (type === "vless" && p.encryption && p.encryption !== "none")
    throw new Error("不支持 VLESS ENC");
  if (
    type === "vless" &&
    p["reality-opts"] &&
    p.network &&
    !["tcp", "raw"].includes(String(p.network))
  )
    throw new Error("当前 Reality 仅支持 TCP");
  const reality = p["reality-opts"] as Record<string, string> | undefined;
  const ws = p["ws-opts"] as
    { path?: string; headers?: { Host?: string } } | undefined;
  if (type === "vless" && !reality && p.network !== "ws")
    throw new Error("仅支持 VLESS WS 或 Reality");
  return nodeSchema.parse({
    id,
    name: p.name,
    protocol:
      type === "vless" ? (reality ? "vless-reality" : "vless-ws") : type,
    address: p.server,
    port: p.port,
    password: p.password || p.psk || "",
    uuid: p.uuid || "",
    sni: p.servername || p.sni || "",
    tls: p.tls ?? true,
    insecure: p["skip-cert-verify"] ?? false,
    publicKey: reality?.["public-key"] || "",
    shortId: reality?.["short-id"] || "",
    path: ws?.path || "/",
    host: ws?.headers?.Host || "",
    snellMode: p.mode || "default",
    certificatePin: p.fingerprint || "",
    obfs: type === "hysteria2" ? p.obfs || "" : "",
    obfsPassword: p["obfs-password"] || "",
    alpn: p.alpn || [],
    tagId,
    source: "subscription",
  });
}
export function canonicalNode(n: ProxyNode) {
  const { id: _id, name: _name, tagId: _tag, source: _source, ...identity } = n;
  return stringify(identity);
}
