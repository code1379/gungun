import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import {
  domainSchema,
  matchesDNSName,
  portSchema,
  type ProxyNode,
  type VPS,
} from "@gungun/domain";
import {
  Cloudflare,
  withCloudflareMutation,
  managedRule,
  originRef,
  type DNSRecord,
  type OriginRule,
  type TunnelIngress,
} from "./cloudflare";
import type { Store } from "./store";
const resourceId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const revision = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dnsInput = z
  .object({
    type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA"]),
    name: domainSchema,
    content: z.string().min(1).max(4096),
    ttl: z.number().int().min(1).max(86400),
    proxied: z.boolean(),
    priority: z.number().int().min(0).max(65535).optional(),
  })
  .superRefine((r, ctx) => {
    if (
      (r.type === "A" && isIP(r.content) !== 4) ||
      (r.type === "AAAA" && isIP(r.content) !== 6)
    )
      ctx.addIssue({ code: "custom", message: "IP 地址与记录类型不匹配" });
    if (r.proxied && !["A", "AAAA", "CNAME"].includes(r.type))
      ctx.addIssue({ code: "custom", message: "该类型不支持橙云代理" });
    if (r.ttl !== 1 && r.ttl < 60)
      ctx.addIssue({
        code: "custom",
        message: "TTL 使用自动（1）或至少 60 秒",
      });
    if (r.type === "MX" && r.priority === undefined)
      ctx.addIssue({ code: "custom", message: "MX 记录需要优先级" });
  });
export class CloudflareResources {
  constructor(
    private store: Store,
    private client = () => new Cloudflare(store.settings()),
  ) {}
  invoke(input: unknown) {
    return withCloudflareMutation(() => this.execute(input));
  }
  private async execute(input: unknown) {
    const q = z
      .object({
        action: z.enum([
          "dns",
          "dnsSave",
          "dnsDelete",
          "tunnels",
          "ingress",
          "ingressSave",
          "edge",
          "origins",
          "originSave",
          "originDelete",
          "audit",
        ]),
        zone: resourceId.optional(),
        account: resourceId.optional(),
        id: resourceId.optional(),
        expected: z.string().optional(),
        confirm: z.boolean().default(false),
        confirmExternal: z.boolean().default(false),
        adopt: z.boolean().default(false),
        data: z.unknown().optional(),
      })
      .parse(input);
    const cf = this.client();
    const zones = q.action === "audit" ? [] : await cf.zones();
    const zone = zones.find((zone) => zone.id === q.zone);
    if (q.zone && !zone) throw new Error("Zone 不属于当前账号或无权访问");
    if (q.account && !zones.some((zone) => zone.account.id === q.account))
      throw new Error("账号不可访问");
    const mutation = /Save$|Delete$/.test(q.action);
    try {
      let result: unknown;
      if (q.action === "audit") return this.store.audits();
      if (q.action === "dns") {
        if (!zone) throw new Error("请选择 Zone");
        return (await cf.dnsRecords(zone.id)).map((r) => ({
          ...r,
          managed: r.comment === "Gungun managed",
          revision: revision(r),
        }));
      }
      if (q.action === "dnsSave" || q.action === "dnsDelete") {
        if (!zone) throw new Error("请选择 Zone");
        const path = `/zones/${zone.id}/dns_records`;
        const before = q.id
          ? await cf.request<DNSRecord>(`${path}/${q.id}`)
          : undefined;
        if (before) this.guard(before, before.comment === "Gungun managed", q);
        if (q.action === "dnsDelete") {
          if (!before) throw new Error("记录不存在");
          result = await cf.request(`${path}/${q.id}`, "DELETE");
        } else {
          const data = dnsInput.parse(q.data);
          if (!(data.name === zone.name || data.name.endsWith("." + zone.name)))
            throw new Error("域名必须属于所选 Zone");
          if (["SRV", "CAA"].includes(data.type))
            throw new Error("SRV / CAA 请在 Cloudflare 控制台编辑结构化字段");
          result = await cf.request(
            q.id ? `${path}/${q.id}` : path,
            q.id ? "PATCH" : "POST",
            {
              ...data,
              comment: q.adopt
                ? "Gungun managed"
                : before?.comment || (before ? "" : "Gungun managed"),
            },
          );
        }
      }
      if (q.action === "tunnels") {
        if (!q.account) throw new Error("请选择账号");
        const tunnels = await cf.pages<{
          id: string;
          name: string;
          status: string;
          created_at: string;
          deleted_at?: string;
        }>(`/accounts/${q.account}/cfd_tunnel?is_deleted=false`);
        return tunnels.map((t) => ({
          ...t,
          vps: this.store
            .all<VPS>("vps")
            .filter((v) => v.tunnelId === t.id && v.accountId === q.account)
            .map((v) => ({ id: v.id, name: v.name })),
        }));
      }
      if (q.action === "ingress" || q.action === "ingressSave") {
        if (!q.account || !q.id) throw new Error("缺少 Tunnel 标识");
        const path = `/accounts/${q.account}/cfd_tunnel/${q.id}/configurations`;
        const before = await cf.request<{
          config: { ingress?: TunnelIngress[]; [key: string]: unknown };
        }>(path);
        const vps = this.store
          .all<VPS>("vps")
          .find((v) => v.tunnelId === q.id && v.accountId === q.account);
        const tracked = vps
          ? this.store.local<string[]>(`tunnelRoutes:${q.account}:${q.id}`) ||
            []
          : [];
        const names = [
          ...tracked,
          ...this.store
            .all<ProxyNode>("nodes")
            .filter((n) => n.vpsId === vps?.id && n.access === "argo")
            .map((n) => n.host || n.sni || n.address),
        ];
        if (q.action === "ingress")
          return {
            config: before.config,
            revision: revision(before),
            managedHosts: vps ? names : [],
          };
        if (!vps) throw new Error("外部 Tunnel 仅支持查看");
        this.guard(before, true, q);
        const edit = z
          .object({
            hostname: domainSchema,
            service: z.string().regex(/^https?:\/\/127\.0\.0\.1:\d{1,5}$/),
            operation: z.enum(["save", "remove"]).default("save"),
          })
          .parse(q.data);
        const port = Number(
          new URL(edit.service).port ||
            (edit.service.startsWith("https:") ? 443 : 80),
        );
        portSchema.parse(port);
        if (!names.includes(edit.hostname))
          throw new Error("仅允许管理已关联 Gungun 节点的路由");
        const existing = before.config.ingress || [];
        const matches = existing.filter(
          (entry) => entry.hostname === edit.hostname && !entry.path,
        );
        if (matches.length > 1)
          throw new Error("同名 Tunnel 路由不唯一，请到控制台核验");
        let found = false;
        const ingress = existing.flatMap((entry) => {
          if (entry.hostname !== edit.hostname || entry.path) return [entry];
          found = true;
          return edit.operation === "remove"
            ? []
            : [{ ...entry, service: edit.service }];
        });
        if (!found && edit.operation === "save") {
          if (
            existing.some(
              (entry) => entry.hostname === edit.hostname && entry.path,
            )
          )
            throw new Error("同名外部按路径路由需要在控制台核验");
          const fallback = ingress.findIndex(
            (entry) => !entry.hostname && !entry.path,
          );
          ingress.splice(fallback < 0 ? ingress.length : fallback, 0, {
            hostname: edit.hostname,
            service: edit.service,
          });
        }
        if (!found && edit.operation === "remove")
          throw new Error("路由已不存在，请刷新");

        result = await cf.request(path, "PUT", {
          config: { ...before.config, ingress },
        });
      }
      if (q.action === "edge") {
        if (!zone) throw new Error("请选择 Zone");
        const certificates = await cf.edgeCertificates(zone.id);
        const host = q.data ? domainSchema.parse(q.data) : "";
        const covered = certificates.packs
          ? certificates.packs
              .filter((p) => p.status === "active")
              .some((p) =>
                p.hosts.some((pattern) => matchesDNSName(pattern, host)),
              )
          : null;
        return {
          ...certificates,
          hostname: host,
          covered: host ? covered : null,
        };
      }
      if (q.action === "origins") {
        if (!zone) throw new Error("请选择 Zone");
        const rs = await cf.originRules(zone.id);
        return {
          id: rs.id,
          rules: rs.rules.map((r, i) => ({
            ...r,
            managed: managedRule(r),
            priority: i + 1,
            revision: revision(r),
          })),
        };
      }
      if (q.action === "originSave" || q.action === "originDelete") {
        if (!zone) throw new Error("请选择 Zone");
        const rs = await cf.originRules(zone.id);
        const before = rs.rules.find((r) => r.id === q.id);
        if (q.id && !before) throw new Error("规则已删除，请刷新");
        if (before) this.guard(before, managedRule(before), q);
        if (q.action === "originDelete") {
          if (!before) throw new Error("请选择规则");
          result = await cf.request(
            `/zones/${zone.id}/rulesets/${rs.id}/rules/${before.id}`,
            "DELETE",
          );
        } else {
          const data = z
            .object({
              hostname: domainSchema.optional(),
              expression: z.string().min(1).max(4096),
              port: portSchema,
              enabled: z.boolean(),
              priority: z.number().int().min(1).optional(),
            })
            .parse(q.data);
          if (!before && !data.hostname) throw new Error("新规则需要域名");
          const ref = before?.ref || originRef(data.hostname!);
          if (!before && rs.rules.some((r) => r.ref === ref))
            throw new Error("此域名已有规则，请编辑现有规则");
          const rule: OriginRule = {
            ...before,
            ref,
            description: before?.description || `Gungun ${data.hostname}`,
            expression: data.expression,
            action: "route",
            enabled: data.enabled,
            action_parameters: {
              ...before?.action_parameters,
              origin: { ...before?.action_parameters?.origin, port: data.port },
            },
          };
          if (before && before.action !== "route")
            throw new Error("该规则不支持端口编辑，请前往 Cloudflare 控制台");
          result = await cf.saveOrigin(
            zone.id,
            rule,
            rs.id,
            before,
            data.priority,
          );
        }
      }
      if (mutation)
        this.store.audit(
          q.action,
          `${q.zone || q.account}/${q.id || "new"}`,
          true,
        );
      return result;
    } catch (error) {
      if (mutation)
        this.store.audit(
          q.action,
          `${q.zone || q.account}/${q.id || "new"}`,
          false,
          "操作失败；详情请查看当前错误提示",
        );
      throw error;
    }
  }
  private guard(
    value: unknown,
    managed: boolean,
    q: { expected?: string; confirm: boolean; confirmExternal: boolean },
  ) {
    if (!q.confirm) throw new Error("修改或删除资源需要明确确认");
    if (!managed && !q.confirmExternal) throw new Error("外部资源需要单独确认");
    if (q.expected !== revision(value))
      throw new Error("资源已发生变化，请刷新后重新确认");
  }
}
