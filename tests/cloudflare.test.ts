import { describe, it, expect } from "vitest";
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
    const service = await server((req, body, res) => {
      expect(req.headers["x-auth-email"]).toBe("user@example.com");
      expect(req.headers["x-auth-key"]).toBe("test-global-key");
      calls.push({ method: req.method!, body });
      if (req.method === "GET")
        reply(res, [
          {
            id: "record-id",
            type: "A",
            name: "node.example.com",
            content: "203.0.113.1",
            proxied: false,
            ttl: 120,
          },
        ]);
      else reply(res, { id: "record-id", ...body });
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
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "PUT"]);
      expect(calls[2].body.content).toBe("203.0.113.1");
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
