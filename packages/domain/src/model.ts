import { z } from "zod";
export const protocolSchema = z.enum([
  "hysteria2",
  "tuic",
  "anytls",
  "snell",
  "vless-ws",
  "vless-reality",
]);
export type Protocol = z.infer<typeof protocolSchema>;
export const portSchema = z.number().int().min(1).max(65535);
export const hostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.:_-]+$/, "地址只能包含主机名或 IP");
export const domainSchema = z
  .string()
  .toLowerCase()
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "请输入有效域名",
  );
export const vpsSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  kind: z.enum(["public", "nat"]),
  address: hostSchema,
  publicAddress: hostSchema,
  sshPort: portSchema.default(22),
  username: z.string().regex(/^[a-z_][a-z0-9_-]*[$]?$/i),
  auth: z.enum(["key", "password"]),
  keyPath: z.string().default(""),
  password: z.string().default(""),
  jumpId: z.string().uuid().nullable().default(null),
  tailscale: z.boolean().default(false),
  namespace: z.string().regex(/^[a-z0-9]{5,12}$/),
  zoneId: z.string().default(""),
  zoneName: z.string().default(""),
  accountId: z.string().default(""),
  tunnelId: z.string().default(""),
});
export type VPS = z.infer<typeof vpsSchema>;
export const nodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  protocol: protocolSchema,
  address: hostSchema,
  port: portSchema,
  password: z.string().default(""),
  uuid: z.string().default(""),
  sni: z.string().default(""),
  tls: z.boolean().default(true),
  insecure: z.boolean().default(false),
  host: z.string().default(""),
  path: z.string().default("/"),
  publicKey: z.string().default(""),
  shortId: z.string().default(""),
  fingerprint: z.string().default("chrome"),
  certificatePin: z
    .string()
    .transform((s) => s.replaceAll(":", "").toLowerCase())
    .pipe(
      z
        .string()
        .regex(/^(?:[a-f0-9]{64})?$/, "证书 SHA256 指纹应为 64 位十六进制"),
    )
    .default(""),
  obfs: z.enum(["", "salamander"]).default(""),
  obfsPassword: z.string().default(""),

  alpn: z.array(z.string()).default([]),
  snellMode: z.enum(["default", "unshaped", "unsafe-raw"]).default("default"),
  tagId: z.string().min(1),
  vpsId: z.string().nullable().default(null),
  serviceId: z.string().default(""),
  source: z.enum(["vps", "subscription", "manual"]).default("manual"),
  access: z.enum(["direct", "cdn", "argo"]).default("direct"),
});
export type ProxyNode = z.infer<typeof nodeSchema>;
export const chainSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    nodeIds: z.array(z.string()).min(2).max(8),
  })
  .refine(
    (c) => new Set(c.nodeIds).size === c.nodeIds.length,
    "链路不可重复引用同一节点",
  );
export type Chain = z.infer<typeof chainSchema>;
export const tagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: z.enum(["vps", "manual", "subscription", "aggregate"]),
  tagIds: z.array(z.string()).default([]),
  url: z.string().default(""),
});
export type Tag = z.infer<typeof tagSchema>;
export const serviceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,50}$/),
    protocol: protocolSchema,
    port: z.number().int().min(0).max(65535),
    publicPort: z.number().int().min(0).max(65535),
    edgePort: portSchema.default(443),
    access: z.enum(["direct", "cdn", "argo"]),
    egress: z.enum(["DIRECT", "WARP"]).default("DIRECT"),
    domain: z.union([z.literal(""), domainSchema]).default(""),
    password: z.string().default(""),
    uuid: z.string().default(""),
    path: z
      .string()
      .regex(/^\/[a-zA-Z0-9/_-]*$/)
      .default("/gungun"),
    realityServer: hostSchema.default("www.microsoft.com"),
    realityPort: portSchema.default(443),
  })
  .superRefine((s, c) => {
    if (s.access !== "direct" && s.protocol !== "vless-ws")
      c.addIssue({
        code: "custom",
        message: "仅 VLESS + WS 支持 CDN 和 Argo",
        path: ["access"],
      });
    if (
      s.access === "cdn" &&
      ![443, 2053, 2083, 2087, 2096, 8443].includes(s.edgePort)
    )
      c.addIssue({
        code: "custom",
        message: "不支持的 Cloudflare HTTPS Edge 端口",
        path: ["edgePort"],
      });
  });
export type Service = z.infer<typeof serviceSchema>;
export const websiteSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,50}$/),
  domain: domainSchema,
  target: hostSchema,
  targetPort: portSchema,
  upstreamTLS: z.boolean().default(false),
  access: z.enum(["direct", "cdn", "argo"]),
  port: portSchema.default(443),
  publicPort: portSchema.default(443),
  edgePort: portSchema.default(443),
});
export type Website = z.infer<typeof websiteSchema>;
export interface RemoteState {
  schemaVersion: 1;
  hostId: string;
  hostName?: string;
  kind: "public" | "nat";
  publicAddress: string;
  namespace: string;
  zoneName: string;
  services: Service[];
  websites: Website[];
  tunnelToken?: string;
  disableTunnel?: boolean;
  realityPrivateKey?: string;
  realityPublicKey?: string;
  realityShortId?: string;
  certificate?: { notAfter: string; domain: string; domains?: string[] };
}
export interface TestResult {
  subjectId: string;
  kind: "node" | "chain";
  sourceId: string;
  latencyMs: number | null;
  speedMBps: number | null;
  error: string | null;
  testedAt: string;
  hops?: {
    nodeId: string;
    ok: boolean;
    latencyMs: number | null;
    error: string | null;
  }[];
}
export interface TaskStep {
  name: string;
  state: "running" | "success" | "failed";
  message?: string;
  at: string;
}
export interface Task {
  output?: unknown;
  id: string;
  type: string;
  vpsId: string | null;
  state: "queued" | "running" | "success" | "failed" | "interrupted";
  progress: number;
  steps: TaskStep[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export const settingsSchema = z.object({
  concurrency: z.number().int().min(1).max(50).default(10),
  latencyUrl: z.url().default("https://www.gstatic.com/generate_204"),
  downloadUrl: z
    .url()
    .default("https://speed.cloudflare.com/__down?bytes=10000000"),
  downloadBytes: z.number().int().min(100000).max(100000000).default(10000000),
  timeoutMs: z.number().int().min(3000).max(120000).default(20000),
  cloudflareEmail: z.string().default(""),
  cloudflareKey: z.string().default(""),
  sshKeyPath: z.string().default(""),
  acmeEmail: z.string().default(""),
});
export type Settings = z.infer<typeof settingsSchema>;
export interface Snapshot {
  vps: VPS[];
  nodes: ProxyNode[];
  chains: Chain[];
  tags: Tag[];
  tasks: Task[];
  results: TestResult[];
  settings: Settings;
}
export function resolveTag(
  tagId: string,
  nodes: ProxyNode[],
  tags: Tag[],
): ProxyNode[] {
  if (tagId === "all") return nodes;
  const selected = new Set<string>();
  function walk(id: string, stack: Set<string>) {
    if (stack.has(id)) throw new Error("聚合组循环引用");
    const tag = tags.find((t) => t.id === id);
    if (!tag) throw new Error("Tag 不存在");
    if (tag.kind === "aggregate") {
      for (const child of tag.tagIds) walk(child, new Set([...stack, id]));
    } else selected.add(id);
  }
  walk(tagId, new Set());
  return nodes.filter((n) => selected.has(n.tagId));
}
export function validateVpsGraph(items: VPS[]) {
  for (const v of items) {
    const seen = new Set([v.id]);
    let parent = v.jumpId;
    while (parent) {
      if (seen.has(parent)) throw new Error("跳板机形成循环");
      seen.add(parent);
      const jump = items.find((x) => x.id === parent);
      if (!jump) throw new Error("跳板机不存在");
      parent = jump.jumpId;
    }
  }
}
export function matchesDNSName(pattern: string, hostname: string) {
  const p = pattern.toLowerCase().replace(/\.$/, "");
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (p === h) return true;
  if (!p.startsWith("*.")) return false;
  const suffix = p.slice(1);
  if (!h.endsWith(suffix)) return false;
  const prefix = h.slice(0, -suffix.length);
  return prefix.length > 0 && !prefix.includes(".");
}
