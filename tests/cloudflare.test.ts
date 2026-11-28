import { describe, it, expect, vi } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Cloudflare, compensate } from "../apps/desktop/src/main/cloudflare";
async function server(
  handler: (
    req: IncomingMessage,
    body: Record<string, unknown>,
    res: ServerResponse,
  ) => void,
) {
  const s = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    handler(req, data ? JSON.parse(data) : {}, res);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}
const reply = (res: ServerResponse, result: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      success: status < 400,
      result,
      errors: status < 400 ? [] : [{ code: 123, message: "not allowed" }],
    }),
  );
};
describe("Cloudflare API 与补偿", () => {
  it("Global Key 仅作为本机 API header，DNS 更新可恢复原值", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let current: Record<string, unknown> | undefined;
    const service = await server((req, body, res) => {
      expect(req.headers["x-auth-email"]).toBe("user@example.com");
      expect(req.headers["x-auth-key"]).toBe("test-global-key");
      calls.push({ method: req.method!, body });
      if (req.method === "GET" && req.url?.endsWith("/record-id")) reply(res, current);
      else if (req.method === "GET")
        reply(res, [
          {
            id: "record-id",
            type: "A",
            name: "node.example.com",
            content: "203.0.113.1",
            proxied: false,
            ttl: 120,
            comment: "Gungun managed",
          },
        ]);
      else { current = { id: "record-id", ...body }; reply(res, current); }
    });
    try {
      const cf = new Cloudflare(
        {
          cloudflareEmail: "user@example.com",
          cloudflareKey: "test-global-key",
        },
        service.url,
      );
      const operation = await cf.dns(
        "zone",
        "node.example.com",
        "A",
        "203.0.113.2",
        true,
      );
      await operation.undo();
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
      expect(calls[3].body.content).toBe("203.0.113.1");
      expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(
        "test-global-key",
      );
    } finally {
      await service.close();
    }
  });
  it("新建 DNS 失败前不覆盖不同类型的记录", async () => {
    let writes = 0;
    const service = await server((req, _body, res) => {
      if (req.method !== "GET") writes++;
      reply(res, [
        {
          id: "r",
          type: "CNAME",
          name: "node.example.com",
          content: "external.example.com",
        },
      ]);
    });
    try {
      const cf = new Cloudflare(
        { cloudflareEmail: "x", cloudflareKey: "x" },
        service.url,
      );
      await expect(
        cf.dns("z", "node.example.com", "A", "203.0.113.1", true),
      ).rejects.toThrow("不同类型");
      expect(writes).toBe(0);
    } finally {
      await service.close();
    }
  });
  it("相同 Edge 与公网端口时仅删除指定 Gungun Origin Rule，并可恢复", async () => {
    const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
    const oldRule = { id: "own", ref: "gungun_cdn_example_com", description: "Gungun cdn.example.com", expression: '(http.host eq "cdn.example.com")', action: "route" };
    let rules = [oldRule, { id: "external", ref: "other", action: "route", description: "Other", expression: "true" }];
    const service = await server((req, body, res) => {
      calls.push({ method: req.method!, url: req.url || "", body });
      if (req.method === "DELETE") rules = rules.filter((r) => r.id !== "own");
      if (req.method === "POST") rules.push({ ...body, id: "restored" } as typeof oldRule);
      reply(res, { id: "ruleset", rules });
    });
    try {
      const cf = new Cloudflare({ cloudflareEmail: "x", cloudflareKey: "x" }, service.url);
      const undo = await cf.removeOriginRule("zone", "cdn.example.com");
      expect(calls[1].method).toBe("DELETE"); expect(calls[1].url.endsWith("/rules/own")).toBe(true);
      expect(rules).toHaveLength(1); expect(rules[0].ref).toBe("other");
      await undo(); expect(rules).toHaveLength(2);
    } finally { await service.close(); }
  });
  it("Cloudflare GET 网络瞬断会有限重试，成功后返回结果", async () => {
    const service = await server((_req, _body, res) => reply(res, [{ status: "active", hosts: ["example.com"] }]));
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      attempts++;
      if (attempts < 3) throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
      return originalFetch(...args);
    });
    try {
      const cf = new Cloudflare({ cloudflareEmail: "x", cloudflareKey: "x" }, service.url);
      const result = await cf.edgeHostname("z", "example.com");
      expect(result).toBe("example.com");
      expect(attempts).toBe(3);
    } finally {
      vi.unstubAllGlobals();
      await service.close();
    }
  });

  it("Cloudflare GET 网络错误会显示底层原因和请求路径", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    });
    try {
      const cf = new Cloudflare({ cloudflareEmail: "x", cloudflareKey: "x" });
      await expect(cf.zones()).rejects.toThrow(/GET \/zones\?per_page=50&page=1.*ECONNRESET/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("API 错误不假装成功", async () => {
    const service = await server((_req, _body, res) => reply(res, null, 403));
    try {
      const cf = new Cloudflare(
        { cloudflareEmail: "x", cloudflareKey: "x" },
        service.url,
      );
      await expect(cf.zones()).rejects.toThrow("403");
    } finally {
      await service.close();
    }
  });
  it("逆序补偿并报告回滚自身失败", async () => {
    const order: number[] = [];
    await expect(
      compensate(
        [
          async () => {
            order.push(1);
          },
          async () => {
            order.push(2);
            throw new Error("undo failed");
          },
          async () => {
            order.push(3);
          },
        ],
        new Error("deploy failed"),
      ),
    ).rejects.toThrow("回滚部分失败");
    expect(order).toEqual([3, 2, 1]);
  });
});
it("Free 套餐只检查 Universal SSL 证书包，不请求受限的 Custom Certificates API", async () => {
  const requests: string[] = [];
  const service = await server((req, _body, res) => {
    requests.push(req.url || "");
    if (req.url?.includes("custom_certificates")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: false,
        result: null,
        errors: [{ code: 1011, message: "Plan level does not allow custom certificates with type" }],
      }));
      return;
    }
    reply(
      res,
      req.url?.includes("certificate_packs")
        ? [{ status: "active", hosts: ["example.com", "*.example.com"] }]
        : [],
    );
  });
  try {
    const cf = new Cloudflare(
      { cloudflareEmail: "x", cloudflareKey: "x" },
      service.url,
    );
    expect(
      await cf.edgeHostname(
        "z",
        "cdn.a7k2p.example.com",
        "cdn-a7k2p.example.com",
      ),
    ).toBe("cdn-a7k2p.example.com");
    await expect(
      cf.edgeHostname("z", "custom.a7k2p.example.com"),
    ).rejects.toThrow("Universal SSL");
    expect(requests.every((path) => !path.includes("custom_certificates"))).toBe(true);
  } finally {
    await service.close();
  }
});
