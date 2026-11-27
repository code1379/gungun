import { randomUUID } from "node:crypto";
import { createServer as createHTTPServer, request } from "node:http";
import { createServer as createTCPServer, type AddressInfo, type Server } from "node:net";

async function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
async function close(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function freePort(excluded: ReadonlySet<number>) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const server = createTCPServer((socket) => socket.destroy());
    const port = await listen(server);
    await close(server);
    if (!excluded.has(port)) return port;
  }
  throw new Error("无法分配独立健康探测端口");
}

// Probe a dedicated direct route to a local health server. Test nodes are
// contacted only by the actual latency/download request after startup.
export async function createCoreReadiness(config: Record<string, unknown>) {
  if (!Array.isArray(config.inbounds) || !Array.isArray(config.outbounds) || !config.route || typeof config.route !== "object")
    throw new Error("测速配置缺少有效出入站与路由");
  const inbounds: unknown[] = config.inbounds;
  const excluded = new Set<number>();
  for (const entry of inbounds) {
    if (entry && typeof entry === "object" && "listen_port" in entry && typeof entry.listen_port === "number")
      excluded.add(entry.listen_port);
  }
  const marker = "gungun-ready-" + randomUUID();
  let server = createHTTPServer((_req, res) => {
    res.setHeader("Connection", "close");
    res.end(marker);
  });
  let targetPort = await listen(server);
  while (excluded.has(targetPort)) {
    await close(server);
    server = createHTTPServer((_req, res) => {
      res.setHeader("Connection", "close");
      res.end(marker);
    });
    targetPort = await listen(server);
  }
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await close(server);
  };
  try {
    excluded.add(targetPort);
    const proxyPort = await freePort(excluded);
    const name = "gungun-readiness-" + randomUUID();
    config.inbounds = [...inbounds, { type: "http", tag: name, listen: "127.0.0.1", listen_port: proxyPort }];
    config.outbounds = [...config.outbounds, { type: "direct", tag: name+"-direct" }];
    const route = config.route as Record<string, unknown>;
    const rules = Array.isArray(route.rules) ? route.rules : [];
    route.rules = [{ inbound: [name], action: "route", outbound: name+"-direct" }, ...rules];
    const target = `http://127.0.0.1:${targetPort}/`;
    const probe = () => new Promise<boolean>((resolve) => {
      const req = request({
        host: "127.0.0.1", port: proxyPort, path: target,
        method: "GET", agent: false, timeout: 200,
        headers: { Host: `127.0.0.1:${targetPort}`, Connection: "close" },
      }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 1024) { res.destroy(); resolve(false); }
        });
        res.once("end", () => resolve(res.statusCode === 200 && body === marker));
        res.once("error", () => resolve(false));
        res.once("aborted", () => resolve(false));
      });
      req.once("timeout", () => req.destroy());
      req.once("error", () => resolve(false));
      req.end();
    });
    return {
      async wait(exited: () => boolean) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (exited()) throw new Error("sing-box 启动失败，请检查核心日志");
          if (await probe()) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("sing-box 路由启动超时");
      },
      close: stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

