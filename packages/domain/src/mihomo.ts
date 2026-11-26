import { stringify } from "yaml";
import type { Chain, ProxyNode } from "./model";
export function toMihomo(n: ProxyNode, name = n.name): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name,
    type: n.protocol.startsWith("vless") ? "vless" : n.protocol,
    server: n.address,
    port: n.port,
    udp: true,
  };
  if (n.protocol.startsWith("vless") || n.protocol === "tuic")
    base.uuid = n.uuid;
  else if (n.protocol === "snell") {
    base.psk = n.password;
    base.version = 6;
    base.mode = n.snellMode;
  } else base.password = n.password;
  if (n.protocol === "tuic") {
    base.password = n.password;
    base["congestion-controller"] = "bbr";
  }
  if (n.protocol !== "snell")
    Object.assign(base, {
      sni: n.sni || n.address,
      "skip-cert-verify": n.insecure,
      alpn: n.alpn.length ? n.alpn : undefined,
    });
  if (n.protocol.startsWith("vless")) {
    base.tls = n.tls;
    base.servername = n.sni || n.address;
    base["client-fingerprint"] = n.fingerprint;
    if (n.protocol === "vless-ws") {
      base.network = "ws";
      base["ws-opts"] = {
        path: n.path,
        headers: { Host: n.host || n.sni || n.address },
      };
    } else {
      base.flow = "xtls-rprx-vision";
      base["reality-opts"] = {
        "public-key": n.publicKey,
        "short-id": n.shortId,
      };
    }
  }
  if (n.protocol === "anytls") base["client-fingerprint"] = n.fingerprint;
  return base;
}
export function validateChain(chain: Chain, nodes: ProxyNode[]): ProxyNode[] {
  if (chain.nodeIds.length < 2) throw new Error("链式代理至少需要两跳");
  if (new Set(chain.nodeIds).size !== chain.nodeIds.length)
    throw new Error("链路存在重复节点");
  const ordered = chain.nodeIds.map((id) => {
    const n = nodes.find((x) => x.id === id);
    if (!n) throw new Error(`链路引用的节点已删除：${id}`);
    return n;
  });
  for (let i = 1; i < ordered.length; i++) {
    if (["hysteria2", "tuic"].includes(ordered[i].protocol))
      throw new Error(
        `第 ${i + 1} 跳使用 ${ordered[i].protocol}，需要 UDP 拨号；当前链路仅验证 TCP 拨号，请选择 VLESS、AnyTLS 或 Snell 出口`,
      );
  }
  return ordered;
}
export function chainProxies(chain: Chain, nodes: ProxyNode[]) {
  return validateChain(chain, nodes).map((n, i) => {
    const p = toMihomo(n, `chain-${chain.id}-${i + 1}`);
    if (i > 0) p["dialer-proxy"] = `chain-${chain.id}-${i}`;
    return p;
  });
}
export function mihomoConfig(nodes: ProxyNode[], chain?: Chain, port = 10808) {
  const proxies = chain
    ? chainProxies(chain, nodes)
    : nodes.map((n) => toMihomo(n, `${n.name} [${n.id}]`));
  if (!proxies.length) throw new Error("没有可导出的节点");
  const selected = proxies[proxies.length - 1].name as string;
  return {
    "mixed-port": port,
    "allow-lan": false,
    "bind-address": "127.0.0.1",
    mode: "rule",
    "log-level": "warning",
    ipv6: true,
    proxies,
    "proxy-groups": chain
      ? []
      : [
          {
            name: "Gungun",
            type: "select",
            proxies: proxies.map((p) => p.name),
          },
        ],
    rules: [`MATCH,${chain ? selected : "Gungun"}`],
  };
}
export function exportMihomo(nodes: ProxyNode[], chains: Chain[] = []) {
  if (!nodes.length && !chains.length) throw new Error("没有可导出的节点");
  const proxies: Record<string, unknown>[] = nodes.map((n) =>
    toMihomo(n, `${n.name} [${n.id}]`),
  );
  const names = proxies.map((p) => p.name);
  for (const c of chains) {
    const parts = chainProxies(c, nodes);
    proxies.push(...parts);
    names.push(parts.at(-1)!.name);
  }
  return stringify({
    "mixed-port": 10808,
    "allow-lan": false,
    mode: "rule",
    proxies,
    "proxy-groups": [{ name: "Gungun", type: "select", proxies: names }],
    rules: ["MATCH,Gungun"],
  });
}
