import type { Chain, ProxyNode } from "./model";
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
