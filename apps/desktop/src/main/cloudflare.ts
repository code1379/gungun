import { randomBytes } from "node:crypto";
import { matchesDNSName, type Settings, type VPS } from "@gungun/domain";
export interface Zone {
  id: string;
  name: string;
  account: { id: string; name: string };
}
interface CFResponse<T> {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
  result_info?: { total_pages: number };
}
export interface DNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment?: string;
  proxiable?: boolean;
}
export interface OriginRule {
  id?: string;
  ref?: string;
  description?: string;
  expression: string;
  action: string;
  action_parameters?: { origin?: { port?: number }; [key: string]: unknown };
  enabled?: boolean;
  version?: string;
}
export interface TunnelIngress {
  hostname?: string;
  service: string;
  [key: string]: unknown;
}
export const originRef = (hostname: string) => `gungun_${hostname.replaceAll(".", "_")}`;
export const managedRule = (rule: OriginRule) => rule.ref?.startsWith("gungun_") === true && rule.description?.startsWith("Gungun ") === true;

function describeFetchError(error: unknown) {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      details.push(`${current.name}: ${current.message}${code ? ` (${code})` : ""}`);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      details.push(String(current));
      break;
    }
  }
  return details.join(" <- ") || String(error);
}

function isRetryableFetchError(error: unknown) {
  const retryableCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ]);
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      if (
        retryableCodes.has(code || "") ||
        current.name === "TimeoutError" ||
        current instanceof TypeError
      )
        return true;
      current = (current as Error & { cause?: unknown }).cause;
    } else break;
  }
  return false;
}
let mutationLane: Promise<unknown> = Promise.resolve();
export function withCloudflareMutation<T>(operation: () => Promise<T>): Promise<T> {
  const task = mutationLane.then(operation);
  mutationLane = task.catch(() => {});
  return task;
}
export class Cloudflare {
  constructor(
    private settings: Pick<Settings, "cloudflareEmail" | "cloudflareKey">,
    private base = "https://api.cloudflare.com/client/v4",
    private recordTunnel?: (account: string, tunnel: string, hosts: string[]) => void,
  ) {}
  async pages<T>(path: string) {
    const result: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const rows = await this.request<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`);
      result.push(...rows);
      if (rows.length < 50) return result;
    }
    throw new Error("Cloudflare 资源分页超过限制，结果未完整读取");
  }
  dnsRecords(zone: string) { return this.pages<DNSRecord>(`/zones/${zone}/dns_records`); }
  async originRules(zone: string): Promise<{ id: string; rules: OriginRule[] }> {
    try { return await this.request(`/zones/${zone}/rulesets/phases/http_request_origin/entrypoint`); }
    catch (error) { if (String(error).includes("Cloudflare 404:")) return { id: "", rules: [] }; throw error; }
  }
  async saveOrigin(zone: string, rule: OriginRule, ruleset: string, before?: OriginRule, position?: number) {
    const { ref, description, expression, action, action_parameters, enabled } = rule;
    const body = { ref, description, expression, action, action_parameters, enabled };
    const data = { ...body, ...(position ? { position: { index: position } } : {}) };
    if (!ruleset) {
      const created = await this.request<{ id: string; rules: OriginRule[] }>(`/zones/${zone}/rulesets`, "POST", {
        name: "Gungun origin ports", kind: "zone", phase: "http_request_origin", rules: [body],
      });
      return { ruleset: created.id, rule: created.rules[0] };
    }
    const saved = await this.request<{ id: string; rules: OriginRule[] }>(`/zones/${zone}/rulesets/${ruleset}/rules${before?.id ? `/${before.id}` : ""}`, before ? "PATCH" : "POST", data);
    const savedRule = saved.rules.find((r) => before?.id ? r.id === before.id : r.ref === rule.ref);
    if (!savedRule) throw new Error("Origin Rule API 未返回写入后的规则，请刷新核验");
    return { ruleset, rule: savedRule };
  }
  async edgeCertificates(zone: string) {
    const results = await Promise.allSettled([
      this.request<{ enabled: boolean }>(`/zones/${zone}/ssl/universal/settings`),
      this.pages<{ id: string; status: string; type: string; hosts: string[]; certificates?: { expires_on?: string; issued_on?: string; hosts?: string[]; status?: string }[] }>(`/zones/${zone}/ssl/certificate_packs`),
    ]);
    return {
      universal: results[0].status === "fulfilled" ? results[0].value : null,
      packs: results[1].status === "fulfilled" ? results[1].value : null,
      errors: results.flatMap((r) => r.status === "rejected" ? [String(r.reason)] : []),
    };
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const requestMethod = method.toUpperCase();
    const attempts = requestMethod === "GET" ? 3 : 1;
    let response: Response | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        response = await fetch(this.base + path, {
          method: requestMethod,
          headers: {
            "X-Auth-Email": this.settings.cloudflareEmail,
            "X-Auth-Key": this.settings.cloudflareKey,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        break;
      } catch (error) {
        const detail = describeFetchError(error);
        if (attempt < attempts && isRetryableFetchError(error)) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
          continue;
        }
        throw new Error(
          `Cloudflare API 网络请求失败（${requestMethod} ${path}）：${detail}`,
          { cause: error },
        );
      }
    }

    if (!response) throw new Error(`Cloudflare API 请求失败（${requestMethod} ${path}）`);
    const d = (await response.json()) as CFResponse<T>;
    if (!response.ok || !d.success)
      throw new Error(
        `Cloudflare ${response.status}: ${d.errors?.map((x) => `${x.code} ${x.message}`).join("; ") || "请求失败"}`,
      );
    return d.result;
  }
  async zones() {
    const result: Zone[] = [];
    for (let page = 1; page <= 100; page++) {
      const chunk = await this.request<Zone[]>(
        `/zones?per_page=50&page=${page}`,
      );
      result.push(...chunk);
      if (chunk.length < 50) return result;
    }
    throw new Error("Zone 分页超过限制");
  }
  async dns(
    zone: string,
    name: string,
    type: string,
    content: string,
    proxied: boolean,
  ) {
    const path = `/zones/${zone}/dns_records`;
    const old = await this.request<DNSRecord[]>(
      `${path}?name=${encodeURIComponent(name)}&per_page=100`,
    );
    const conflicts = old.filter((r) => r.type !== type);
    if (conflicts.length)
      throw new Error(
        `${name} 已存在不同类型 DNS 记录，请在 Cloudflare 核验后处理`,
      );
    if (old[0] && old[0].comment !== "Gungun managed")
      throw new Error(`${name} 是外部 DNS 记录，请先在 Cloudflare 管理中心确认接管后再部署`);
    const data = { type, name, content, proxied, ttl: 1, comment: "Gungun managed" };
    if (old.length > 1) throw new Error("同名 DNS 存在多个记录，请先清理");
    const before = old[0];
    const record = await this.request<DNSRecord>(
      before ? `${path}/${before.id}` : path,
      before ? "PUT" : "POST",
      data,
    );
    return {
      record,
      undo: async () => {
        const current = await this.request<DNSRecord>(`${path}/${record.id}`);
        const fields = ["type", "name", "content", "proxied", "ttl", "comment"] as const;
        if (fields.some((key) => current[key] !== record[key])) throw new Error("DNS 已被外部修改，停止回滚");
        if (before) {
          const { type, name, content, proxied, ttl, comment } = before;
          await this.request(`${path}/${before.id}`, "PUT", {
            type,
            name,
            content,
            proxied,
            ttl, comment,
          });
        } else await this.request(`${path}/${record.id}`, "DELETE");
      },
    };
  }
  async tunnel(vps: VPS) {
    if (vps.tunnelId)
      return {
        id: vps.tunnelId,
        created: false,
        token: await this.request<string>(
          `/accounts/${vps.accountId}/cfd_tunnel/${vps.tunnelId}/token`,
        ),
      };
    const name = `gungun-${
      vps.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 20) || "vps"
    }-${vps.namespace}-tunnel`;
    const t = await this.request<{ id: string }>(
      `/accounts/${vps.accountId}/cfd_tunnel`,
      "POST",
      {
        name,
        config_src: "cloudflare",
        tunnel_secret: randomBytes(32).toString("base64"),
      },
    );
    return {
      id: t.id,
      created: true,
      token: await this.request<string>(
        `/accounts/${vps.accountId}/cfd_tunnel/${t.id}/token`,
      ),
    };
  }
  async tunnelConfig(account: string, id: string, ingress: TunnelIngress[], managedHosts: string[] = []) {
    const path = `/accounts/${account}/cfd_tunnel/${id}/configurations`;
    let before: { config?: { ingress?: TunnelIngress[]; [key: string]: unknown } } = {};
    try { before = await this.request(path); }
    catch (error) { if (!String(error).includes("Cloudflare 404:")) throw error; }
    const old = before.config?.ingress || [];
    const names = new Set(ingress.map((r) => r.hostname));
    if (names.size !== ingress.length) throw new Error("Tunnel 路由域名重复");
    const seen = new Set<string>();
    const merged: TunnelIngress[] = [];
    for (const previous of old) {
      if (!previous.hostname && !previous.path) continue;
      const desired = ingress.find((r) => r.hostname === previous.hostname);
      if (previous.path) {
        if (desired) throw new Error(`Tunnel ${previous.hostname} 存在外部按路径路由，请先核验`);
        merged.push(previous); continue;
      }
      if (desired) {
        if (!managedHosts.includes(previous.hostname!) && JSON.stringify(desired) !== JSON.stringify(previous)) throw new Error(`Tunnel 路由 ${previous.hostname} 无可信归属，停止覆盖`);
        if (seen.has(previous.hostname!)) throw new Error("Tunnel 存在重复域名路由，停止覆盖");
        seen.add(previous.hostname!);
        merged.push({ ...previous, ...desired });
      } else if (!managedHosts.includes(previous.hostname!)) merged.push(previous);
    }
    const catchAll = old.find((r) => !r.hostname && !r.path) || { service: "http_status:404" };
    const config = { ...before.config, ingress: [...merged, ...ingress.filter((r) => !seen.has(r.hostname!)), catchAll] };
    await this.request(path, "PUT", { config });
    this.recordTunnel?.(account, id, ingress.flatMap((r) => r.hostname ? [r.hostname] : []));
    return async () => {
      const current = await this.request<{ config: unknown }>(path);
      if (JSON.stringify(current.config) !== JSON.stringify(config)) throw new Error("Tunnel 配置已被修改，停止回滚");
      await this.request(path, "PUT", { config: before.config || { ingress: [{ service: "http_status:404" }] } });
      this.recordTunnel?.(account, id, managedHosts);
    };
  }
  async originRule(zone: string, hostname: string, port: number) {
    const existing = await this.originRules(zone);
    const ref = originRef(hostname);
    const before = existing.rules.find((rule) => rule.ref === ref);
    if (before && !managedRule(before)) throw new Error("同名 Origin Rule 属于外部资源，请在管理中心核验并调整，部署不会自动覆盖");
    const saved = await this.saveOrigin(zone, {
      ref, description: `Gungun ${hostname}`, expression: `(http.host eq "${hostname}")`,
      action: "route", action_parameters: { origin: { port } }, enabled: true,
    }, existing.id, before);
    return async () => {
      const current = await this.originRules(zone);
      const rule = current.rules.find((rule) => rule.id === saved.rule.id);
      if (JSON.stringify(rule) !== JSON.stringify(saved.rule)) throw new Error("Origin Rule 已被修改，停止回滚");
      if (before) await this.saveOrigin(zone, before, saved.ruleset, saved.rule);
      else await this.request(`/zones/${zone}/rulesets/${saved.ruleset}/rules/${saved.rule.id}`, "DELETE");
    };
  }
  async removeOriginRule(zone: string, hostname: string) {
    const existing = await this.originRules(zone);
    const before = existing.rules.find((rule) => rule.ref === originRef(hostname));
    if (!before) return async () => {};
    if (!managedRule(before)) throw new Error("不能删除外部 Origin Rule");
    const position = existing.rules.indexOf(before) + 1;
    await this.request(`/zones/${zone}/rulesets/${existing.id}/rules/${before.id}`, "DELETE");
    return async () => {
      const current = await this.originRules(zone);
      if (current.rules.some((rule) => rule.ref === before.ref)) throw new Error("同名 Origin Rule 已存在，停止回滚");
      await this.saveOrigin(zone, before, existing.id, undefined, position);
    };
  }
  async edgeHostname(zone: string, desired: string, fallback?: string) {
    // Free 套餐依赖 Universal SSL / Edge Certificate Packs。
    // 不请求 custom_certificates：该接口在 Free 套餐会返回 1011，
    // 而且自定义上传证书不是 Gungun 节点部署的前置条件。
    const packs = await this.request<{ status: string; hosts: string[] }[]>(
      `/zones/${zone}/ssl/certificate_packs?per_page=50`,
    );
    const hosts = packs
      .filter((p) => p.status === "active")
      .flatMap((p) => p.hosts || []);
    const covered = (host: string) =>
      hosts.some((pattern) => matchesDNSName(pattern, host));
    if (covered(desired)) return desired;
    if (fallback && covered(fallback)) return fallback;
    throw new Error(
      `Cloudflare 当前生效的 Universal SSL 边缘证书不覆盖 ${desired}。如果这是 Gungun 自动生成的域名，请检查 Zone 的 Universal SSL 是否已启用；自定义域名则需要使用当前边缘证书已覆盖的主机名。`,
    );
  }
  async createChallenge(zone: string, name: string, value: string) {
    const record = await this.request<{ id: string }>(
      `/zones/${zone}/dns_records`,
      "POST",
      { type: "TXT", name, content: value, ttl: 60 },
    );
    return async () => {
      await this.request(`/zones/${zone}/dns_records/${record.id}`, "DELETE");
    };
  }
}
export async function compensate(
  undo: (() => Promise<void>)[],
  error: unknown,
): Promise<never> {
  const failures: string[] = [];
  for (const fn of undo.reverse())
    try {
      await fn();
    } catch (e) {
      failures.push(String(e));
    }
  throw new Error(
    `${String(error)}${failures.length ? `；回滚部分失败：${failures.join("; ")}` : "；已回滚已完成的操作"}`,
  );
}
