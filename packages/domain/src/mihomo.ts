import { stringify } from "yaml";
import type { Chain, ProxyNode } from "./model";
import { validateChain } from "./chains";
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
  if (n.certificatePin) base.fingerprint = n.certificatePin;
  if (n.protocol === "hysteria2" && n.obfs) {
    base.obfs = n.obfs;
    base["obfs-password"] = n.obfsPassword;
  }
  if (n.protocol === "anytls") base["client-fingerprint"] = n.fingerprint;
  return base;
}
export function chainProxies(chain: Chain, nodes: ProxyNode[]) {
  return validateChain(chain, nodes).map((n, i) => {
    const p = toMihomo(n, `chain-${chain.id}-${i + 1}`);
    if (i > 0) p["dialer-proxy"] = `chain-${chain.id}-${i}`;
    return p;
  });
}
export function exportMihomo(nodes: ProxyNode[], chains: Chain[] = []) {
  if (!nodes.length && !chains.length) throw new Error("没有可导出的节点");
  const proxies: Record<string, unknown>[] = chains.length
    ? []
    : nodes.map((n) => toMihomo(n, `${n.name} [${n.id}]`));
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

