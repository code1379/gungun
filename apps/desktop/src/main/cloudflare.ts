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
interface DNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}
export class Cloudflare {
  constructor(
    private settings: Pick<Settings, "cloudflareEmail" | "cloudflareKey">,
    private base = "https://api.cloudflare.com/client/v4",
  ) {}
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const r = await fetch(this.base + path, {
      method,
      headers: {
        "X-Auth-Email": this.settings.cloudflareEmail,
        "X-Auth-Key": this.settings.cloudflareKey,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const d = (await r.json()) as CFResponse<T>;
    if (!r.ok || !d.success)
      throw new Error(
        `Cloudflare ${r.status}: ${d.errors?.map((x) => `${x.code} ${x.message}`).join("; ") || "请求失败"}`,
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
    const data = { type, name, content, proxied, ttl: 1 };
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
        if (before) {
          const { type, name, content, proxied, ttl } = before;
          await this.request(`${path}/${before.id}`, "PUT", {
            type,
            name,
            content,
            proxied,
            ttl,
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
  async tunnelConfig(
    account: string,
    id: string,
    ingress: { hostname?: string; service: string }[],
  ) {
    const path = `/accounts/${account}/cfd_tunnel/${id}/configurations`;
    let before: { config?: unknown } = {};
    try {
      before = await this.request(path);
    } catch (e) {
      if (!String(e).includes("404")) throw e;
    }
    await this.request(path, "PUT", {
      config: { ingress: [...ingress, { service: "http_status:404" }] },
    });
    return async () => {
      await this.request(path, "PUT", {
        config: before.config || { ingress: [{ service: "http_status:404" }] },
      });
    };
  }
  async originRule(zone: string, hostname: string, port: number) {
    const phase = `/zones/${zone}/rulesets/phases/http_request_origin/entrypoint`;
    let existing: { id: string; rules: Record<string, unknown>[] } | undefined;
    try {
      existing = await this.request(phase);
    } catch (e) {
      if (!String(e).includes("404")) throw e;
    }
    const ref = `gungun_${hostname.replaceAll(".", "_")}`;
    const rule = {
      ref,
      description: `Gungun ${hostname}`,
      expression: `(http.host eq "${hostname}")`,
      action: "route",
      action_parameters: { origin: { port } },
      enabled: true,
    };
    const clean = (rs: Record<string, unknown>[]) =>
      rs.map(({ id: _id, version: _v, last_updated: _l, ...r }) => r);
    const old = existing?.rules || [];
    if (existing) {
      const next = clean(old).filter((r) => r.ref !== ref);
      next.push(rule);
      await this.request(`/zones/${zone}/rulesets/${existing.id}`, "PUT", {
        rules: next,
      });
      return async () => {
        await this.request(`/zones/${zone}/rulesets/${existing!.id}`, "PUT", {
          rules: clean(old),
        });
      };
    }
    const created = await this.request<{ id: string }>(
      `/zones/${zone}/rulesets`,
      "POST",
      {
        name: "Gungun origin ports",
        kind: "zone",
        phase: "http_request_origin",
        rules: [rule],
      },
    );
    return async () => {
      await this.request(`/zones/${zone}/rulesets/${created.id}`, "DELETE");
    };
  }
  async removeOriginRule(zone: string, hostname: string) {
    const phase = `/zones/${zone}/rulesets/phases/http_request_origin/entrypoint`;
    let existing: { id: string; rules: Record<string, unknown>[] } | undefined;
    try { existing = await this.request(phase); }
    catch (error) { if (String(error).includes("404")) return async () => {}; throw error; }
    if (!existing) return async () => {};
    const ref = `gungun_${hostname.replaceAll(".", "_")}`;
    const clean = (rules: Record<string, unknown>[]) =>
      rules.map(({ id: _id, version: _version, last_updated: _updated, ...rule }) => rule);
    const old = existing.rules || [];
    const next = clean(old).filter((rule) => rule.ref !== ref);
    if (next.length === old.length) return async () => {};
    await this.request(`/zones/${zone}/rulesets/${existing.id}`, "PUT", { rules: next });
    return async () => {
      await this.request(`/zones/${zone}/rulesets/${existing!.id}`, "PUT", { rules: clean(old) });
    };
  }
  async edgeHostname(zone: string, desired: string, fallback?: string) {
    const packs = await this.request<{ status: string; hosts: string[] }[]>(
      `/zones/${zone}/ssl/certificate_packs?per_page=50`,
    );
    const hosts = packs
      .filter((p) => p.status === "active")
      .flatMap((p) => p.hosts || []);
    try {
      const custom = await this.request<{ status: string; hosts: string[] }[]>(
        `/zones/${zone}/custom_certificates?per_page=50`,
      );
      hosts.push(
        ...custom
          .filter((p) => p.status === "active")
          .flatMap((p) => p.hosts || []),
      );
    } catch (e) {
      if (!/403|404/.test(String(e))) throw e;
    }
    const covered = (host: string) =>
      hosts.some((pattern) => matchesDNSName(pattern, host));
    if (covered(desired)) return desired;
    if (fallback && covered(fallback)) return fallback;
    throw new Error(
      `Cloudflare 当前生效的边缘证书不覆盖 ${desired}。请选择已覆盖的一级域名，或在 Cloudflare 配置覆盖该域名的边缘证书后重试。VPS 的 Let's Encrypt 证书不会改变 Edge 证书覆盖范围。`,
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
