import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/desktop/src/main/store";
import {
  Cloudflare,
  type DNSRecord,
  type OriginRule,
} from "../apps/desktop/src/main/cloudflare";
import {
  CloudflareResources,
  revision,
} from "../apps/desktop/src/main/cloudflare-resources";
const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((p) => rmSync(p, { recursive: true, force: true })),
);
class FakeCloudflare extends Cloudflare {
  records: DNSRecord[] = [];
  rules: OriginRule[] = [];
  ingress = {
    config: {
      ingress: [
        { hostname: "node.example.com", service: "http://127.0.0.1:80" },
        { hostname: "external.example.com", service: "http://127.0.0.1:9000" },
        { service: "http_status:404" },
      ],
      extra: "keep",
    },
  };
  writes: { path: string; method: string; body: unknown }[] = [];
  constructor() {
    super({
      cloudflareEmail: "local@example.com",
      cloudflareKey: "secret-local-key",
    });
  }
  override async zones() {
    return [
      {
        id: "zone",
        name: "example.com",
        account: { id: "account", name: "Example" },
      },
    ];
  }
  override async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const value = body as Record<string, unknown>;
    if (method !== "GET") this.writes.push({ path, method, body });
    let result: unknown;
    if (path.includes("dns_records")) {
      const id = path.split("/").at(-1)!;
      if (method === "GET")
        result =
          id === "dns_records" || id.includes("?")
            ? this.records
            : this.records.find((r) => r.id === id);
      if (method === "POST") {
        result = { id: "created", ...value };
        this.records.push(result as DNSRecord);
      }
      if (method === "PATCH") {
        result = { ...this.records.find((r) => r.id === id), ...value };
        this.records = this.records.map((r) =>
          r.id === id ? (result as DNSRecord) : r,
        );
      }
      if (method === "DELETE")
        this.records = this.records.filter((r) => r.id !== id);
    } else if (path.includes("configurations")) {
      if (method === "PUT")
        this.ingress = structuredClone(body) as typeof this.ingress;
      result = this.ingress;
    } else if (path.includes("cfd_tunnel"))
      result = [
        {
          id: "tunnel",
          name: "existing",
          status: "healthy",
          created_at: "2026-01-01",
        },
        { id: "external", name: "external", status: "inactive" },
      ];
    else if (path.includes("universal/settings")) result = { enabled: true };
    else if (path.includes("certificate_packs"))
      result = [
        {
          id: "cert",
          type: "universal",
          status: "active",
          hosts: ["example.com", "*.example.com"],
        },
      ];
    else if (path.includes("rulesets")) {
      if (method === "GET") result = { id: "rs", rules: this.rules };
      if (method === "POST" || method === "PATCH") {
        const id = method === "PATCH" ? path.split("/").at(-1)! : "new-rule";
        const { position: _pos, ...rule } = value;
        if (method === "PATCH")
          this.rules = this.rules.map((r) =>
            r.id === id ? ({ ...r, ...rule } as OriginRule) : r,
          );
        else this.rules.push({ id, ...rule } as OriginRule);
        result = { id: "rs", rules: this.rules };
      }
      if (method === "DELETE")
        this.rules = this.rules.filter((r) => r.id !== path.split("/").at(-1));
    }
    return structuredClone(result) as T;
  }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gungun-cf-"));
  directories.push(dir);
  const store = new Store(join(dir, "test.db"));
  const cf = new FakeCloudflare();
  return { store, cf, api: new CloudflareResources(store, () => cf) };
}
const record = {
  id: "record",
  name: "node.example.com",
  type: "A",
  content: "192.0.2.1",
  proxied: true,
  ttl: 1,
  comment: "Gungun managed",
};
describe("Cloudflare 独立资源管理", () => {
  it("DNS CRUD、TTL、橙灰云与操作审计", async () => {
    const { api, cf, store } = setup();
    try {
      await api.invoke({
        action: "dnsSave",
        zone: "zone",
        data: { ...record, name: "new.example.com" },
      });
      const list = (await api.invoke({
        action: "dns",
        zone: "zone",
      })) as (DNSRecord & { revision: string; managed: boolean })[];
      expect(list[0].managed).toBe(true);
      await api.invoke({
        action: "dnsSave",
        zone: "zone",
        id: "created",
        expected: list[0].revision,
        confirm: true,
        data: { ...record, name: "new.example.com", proxied: false, ttl: 120 },
      });
      expect(cf.records[0].ttl).toBe(120);
      expect(cf.records[0].proxied).toBe(false);
      await api.invoke({
        action: "dnsDelete",
        zone: "zone",
        id: "created",
        expected: revision(cf.records[0]),
        confirm: true,
      });
      expect(cf.records).toEqual([]);
      expect(store.audits()).toHaveLength(3);
      expect(JSON.stringify(store.audits())).not.toContain("secret-local-key");
    } finally {
      store.close();
    }
  });
  it("外部资源需要单独确认、陈旧版本不能覆盖、可明确接管旧 DNS", async () => {
    const { api, cf, store } = setup();
    cf.records = [{ ...record, comment: "another business" }];
    const input = {
      action: "dnsSave",
      zone: "zone",
      id: "record",
      expected: revision(cf.records[0]),
      confirm: true,
      data: record,
    };
    try {
      await expect(api.invoke(input)).rejects.toThrow("外部资源");
      await expect(
        api.invoke({ ...input, confirmExternal: true, expected: "stale" }),
      ).rejects.toThrow("已发生变化");
      expect(cf.writes).toEqual([]);
      await api.invoke({ ...input, confirmExternal: true, adopt: true });
      expect(cf.records[0].comment).toBe("Gungun managed");
    } finally {
      store.close();
    }
  });
  it("Origin Rules 创建、修改、停用、优先级与删除不覆盖其他规则", async () => {
    const { api, cf, store } = setup();
    cf.rules = [
      {
        id: "external",
        ref: "other",
        action: "route",
        expression: "true",
        enabled: true,
      },
    ];
    try {
      await api.invoke({
        action: "originSave",
        zone: "zone",
        data: {
          hostname: "cdn.example.com",
          expression: '(http.host eq "cdn.example.com")',
          port: 45516,
          enabled: true,
        },
      });
      const own = cf.rules[1];
      await api.invoke({
        action: "originSave",
        zone: "zone",
        id: own.id,
        expected: revision(own),
        confirm: true,
        data: {
          expression: own.expression,
          port: 45517,
          enabled: false,
          priority: 1,
        },
      });
      expect(cf.rules[0].ref).toBe("other");
      expect(cf.rules[1].enabled).toBe(false);
      expect((cf.writes[1].body as { position: unknown }).position).toEqual({
        index: 1,
      });
      await api.invoke({
        action: "originDelete",
        zone: "zone",
        id: own.id,
        expected: revision(cf.rules[1]),
        confirm: true,
      });
      expect(cf.rules).toHaveLength(1);
      await expect(
        api.invoke({
          action: "originDelete",
          zone: "zone",
          id: "external",
          expected: revision(cf.rules[0]),
          confirm: true,
        }),
      ).rejects.toThrow("外部资源");
    } finally {
      store.close();
    }
  });
  it("部署和管理页面复用同一个 Origin Rule，不重复创建", async () => {
    const { api, cf, store } = setup();
    try {
      await cf.originRule("zone", "cdn.example.com", 45516);
      await api.invoke({
        action: "originSave",
        zone: "zone",
        id: cf.rules[0].id,
        expected: revision(cf.rules[0]),
        confirm: true,
        data: {
          expression: cf.rules[0].expression,
          port: 45517,
          enabled: true,
        },
      });
      await cf.originRule("zone", "cdn.example.com", 45518);
      expect(cf.rules).toHaveLength(1);
      expect(cf.rules[0].action_parameters?.origin?.port).toBe(45518);
    } finally {
      store.close();
    }
  });
  it("Tunnel 映射到已有 VPS；外部 Tunnel 只读；修改路由保留额外配置", async () => {
    const { api, cf, store } = setup();
    const vps = store.saveVps({
      id: "20bdac8c-4889-470c-8c68-f49d071348f7",
      name: "VPS",
      kind: "public",
      address: "192.0.2.1",
      publicAddress: "192.0.2.1",
      username: "root",
      auth: "password",
      namespace: "abcde",
      accountId: "account",
      tunnelId: "tunnel",
    });
    store.saveNode({
      id: "node",
      name: "node",
      protocol: "vless-ws",
      address: "node.example.com",
      port: 443,
      tagId: `vps-${vps.id}`,
      vpsId: vps.id,
      access: "argo",
      host: "node.example.com",
    });
    try {
      const list = (await api.invoke({
        action: "tunnels",
        account: "account",
      })) as { vps: unknown[] }[];
      expect(list[0].vps).toHaveLength(1);
      expect(list[1].vps).toHaveLength(0);
      await expect(
        api.invoke({
          action: "ingressSave",
          account: "account",
          id: "external",
          confirm: true,
          expected: revision(cf.ingress),
          data: {},
        }),
      ).rejects.toThrow("仅支持查看");
      await api.invoke({
        action: "ingressSave",
        account: "account",
        id: "tunnel",
        confirm: true,
        expected: revision(cf.ingress),
        data: {
          hostname: "node.example.com",
          service: "http://127.0.0.1:12345",
        },
      });
      expect(cf.ingress.config.extra).toBe("keep");
      expect(cf.ingress.config.ingress[1].service).toBe(
        "http://127.0.0.1:9000",
      );
    } finally {
      store.close();
    }
  });
  it("Tunnel 已有 Gungun 路由可以删除及恢复，外部路径和兜底保持不变", async () => {
    const { api, cf, store } = setup();
    store.saveVps({
      id: "20bdac8c-4889-470c-8c68-f49d071348f7",
      name: "VPS",
      kind: "public",
      address: "192.0.2.1",
      publicAddress: "192.0.2.1",
      username: "root",
      auth: "password",
      namespace: "abcde",
      accountId: "account",
      tunnelId: "tunnel",
    });
    store.saveLocal("tunnelRoutes:account:tunnel", ["node.example.com"]);
    try {
      await api.invoke({
        action: "ingressSave",
        account: "account",
        id: "tunnel",
        confirm: true,
        expected: revision(cf.ingress),
        data: {
          hostname: "node.example.com",
          service: "http://127.0.0.1:80",
          operation: "remove",
        },
      });
      expect(cf.ingress.config.ingress.map((r) => r.hostname)).toEqual([
        "external.example.com",
        undefined,
      ]);
      await api.invoke({
        action: "ingressSave",
        account: "account",
        id: "tunnel",
        confirm: true,
        expected: revision(cf.ingress),
        data: {
          hostname: "node.example.com",
          service: "https://127.0.0.1:8443",
        },
      });
      expect(cf.ingress.config.ingress.at(-1)?.service).toBe("http_status:404");
      expect(cf.ingress.config.ingress[0].service).toBe(
        "http://127.0.0.1:9000",
      );
    } finally {
      store.close();
    }
  });
  it("部署 Tunnel 更新保留外部路由顺序、额外配置，回滚前检查外部修改", async () => {
    const { cf, store } = setup();
    try {
      const undo = await cf.tunnelConfig(
        "account",
        "tunnel",
        [{ hostname: "node.example.com", service: "http://127.0.0.1:8080" }],
        ["node.example.com"],
      );
      expect(cf.ingress.config.extra).toBe("keep");
      expect(cf.ingress.config.ingress[1].hostname).toBe(
        "external.example.com",
      );
      cf.ingress.config.extra = "changed by someone else";
      await expect(undo()).rejects.toThrow("已被修改");
    } finally {
      store.close();
    }
  });
  it("Edge 一级通配符覆盖，嵌套域名不会误报覆盖", async () => {
    const { api, store } = setup();
    try {
      const good = (await api.invoke({
        action: "edge",
        zone: "zone",
        data: "web-abcde.example.com",
      })) as { covered: boolean };
      expect(good.covered).toBe(true);
      const bad = (await api.invoke({
        action: "edge",
        zone: "zone",
        data: "cdn.abcde.example.com",
      })) as { covered: boolean };
      expect(bad.covered).toBe(false);
    } finally {
      store.close();
    }
  });
});
