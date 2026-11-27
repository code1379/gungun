import { spawn, execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import {
  singboxConfig,
  type Chain,
  type ProxyNode,
  type Settings,
  type TestResult,
  type VPS,
} from "@gungun/domain";
import type { SSH } from "./ssh";
import { createCoreReadiness } from "./core-readiness";
const exec = promisify(execFile);
export interface Measurement {
  latencyMs: number;
  speedMBps: number | null;
  error: null;
}

export function parseCurlLatencySamples(output: string): number[] {
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      ([status, seconds]) =>
        Number.isFinite(status) &&
        status >= 200 &&
        status < 400 &&
        Number.isFinite(seconds) &&
        seconds > 0,
    )
    .map(([, seconds]) => seconds * 1000);
}
export async function probeTcpEndpoint(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`TCP connection timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

async function freePort() {
  const s = net.createServer();
  await new Promise<void>((r, e) =>
    s.listen(0, "127.0.0.1", r).once("error", e),
  );
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
export class Benchmark {
  constructor(
    private corePath: string,
    private ssh: SSH,
  ) {}
  async measure(
    nodes: ProxyNode[],
    chain: Chain | undefined,
    source: VPS | null,
    settings: Settings,
    speed: boolean,
  ): Promise<Measurement> {
    const downloadURL = new URL(settings.downloadUrl);
    if (
      downloadURL.hostname === "speed.cloudflare.com" &&
      downloadURL.pathname === "/__down"
    )
      downloadURL.searchParams.set("bytes", String(settings.downloadBytes));
    const config = singboxConfig(nodes, chain, await freePort());
    const snellNode =
      !chain && nodes.length === 1 && nodes[0].protocol === "snell"
        ? nodes[0]
        : undefined;
    if (snellNode || process.env.GUNGUN_CORE_DEBUG) config.log.level = "debug";
    let snellTcpReachable = false;
    if (!source && snellNode) {
      try {
        await probeTcpEndpoint(snellNode.address, snellNode.port);
        snellTcpReachable = true;
      } catch (error) {
        throw new Error(
          `${snellNode.name}：Snell v6 TCP ${snellNode.address}:${snellNode.port} 无法连接。请检查 VPS 上该端口是否监听 TCP、NAT 映射和防火墙。底层错误：${String(error)}`,
        );
      }
    }
    if (source)
      return this.ssh.fq<Measurement>(source, "bench", {
        config,
        latencyUrl: settings.latencyUrl,
        downloadUrl: downloadURL.toString(),
        downloadBytes: settings.downloadBytes,
        timeoutMs: settings.timeoutMs,
        speed,
      });
    const dir = await mkdtemp(join(tmpdir(), "gungun-bench-"));
    let child: ReturnType<typeof spawn> | undefined;
    let runtimeLog = "";
    let readiness: Awaited<ReturnType<typeof createCoreReadiness>> | undefined;
    try {
      readiness = await createCoreReadiness(config);
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      child = spawn(this.corePath, ["run", "--disable-color", "-D", dir, "-c", path], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr])
        stream?.on("data", (b: Buffer) => {
          runtimeLog = (runtimeLog + b.toString()).slice(-8000);
        });
      let exited = false;
      let processError: Error | undefined;
      child.once("exit", () => {
        exited = true;
      });
      child.once("error", (e) => {
        processError = e;
        exited = true;
      });
      await readiness.wait(() => exited);
      if (processError) throw processError;
      const port = config.inbounds[0].listen_port;
      // Match v2rayN's real-delay method: two requests over one reusable
      // proxy connection, 100 ms apart, and report the faster successful sample.
      const latencyCommon = [
        "--silent",
        "--show-error",
        "--location",
        "--max-redirs",
        "5",
        "--proxy",
        `socks5h://127.0.0.1:${port}`,
        "--noproxy",
        "",
        "--max-time",
        String(settings.timeoutMs / 1000),
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code} %{time_total}\\n",
      ];
      const { stdout: latencyOutput } = await exec(
        "/usr/bin/curl",
        [...latencyCommon, "--", settings.latencyUrl, settings.latencyUrl],
        {
          timeout: settings.timeoutMs * 2 + 2000,
          env: {
            ...process.env,
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
            http_proxy: "",
            https_proxy: "",
            all_proxy: "",
          },
        },
      );
      const latencySamples = parseCurlLatencySamples(latencyOutput);
      if (!latencySamples.length)
        throw new Error(`延迟测试未获得有效 HTTP 响应：${latencyOutput.trim() || "无响应"}`);
      const latencyMs = Math.min(...latencySamples);
      const common = [
        "--silent",
        "--show-error",
        "--fail",
        "--location",
        "--proxy",
        `socks5h://127.0.0.1:${port}`,
        "--noproxy",
        "",
        "--max-time",
        String(settings.timeoutMs / 1000),
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code} %{time_total} %{size_download}",
      ];
      let speedMBps: number | null = null;
      if (speed) {
        const { stdout: out } = await exec(
          "/usr/bin/curl",
          [
            ...common,
            "--max-filesize",
            String(settings.downloadBytes),
            "--range",
            `0-${settings.downloadBytes - 1}`,
            "--",
            downloadURL.toString(),
          ],
          {
            timeout: settings.timeoutMs + 2000,
            env: {
              ...process.env,
              HTTP_PROXY: "",
              HTTPS_PROXY: "",
              ALL_PROXY: "",
              http_proxy: "",
              https_proxy: "",
              all_proxy: "",
            },
          },
        );
        const [status, duration, size] = out.trim().split(" ").map(Number);
        if (status < 200 || status >= 300 || size < 100000)
          throw new Error("下载数据量不足或响应异常");
        speedMBps = size / duration / 1000000;
      }
      return { latencyMs, speedMBps, error: null };
    } catch (e) {
      const detail = `${String(e)}${runtimeLog ? `\n核心日志：${runtimeLog}` : ""}`;
      if (
        snellNode &&
        snellTcpReachable &&
        (String(e).includes("curl: (28)") || /timed out/i.test(String(e)))
      ) {
        throw new Error(
          `${snellNode.name}：TCP 端口可达，但 Snell v6 代理握手或后续请求超时。请核对客户端与服务端 PSK、Snell v6 mode（当前默认 default），并检查服务端 sing-box 日志。\n${detail}`,
        );
      }
      throw new Error(detail);
    } finally {
      if (child?.pid) {
        child.kill("SIGTERM");
        await new Promise<void>((r) => {
          if (child!.exitCode !== null || child!.signalCode !== null) {
            r();
            return;
          }
          child!.once("exit", () => r());
          setTimeout(() => {
            child?.kill("SIGKILL");
            r();
          }, 2000).unref();
        });
      }
      await readiness?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  async test(
    subject: ProxyNode | Chain,
    nodes: ProxyNode[],
    source: VPS | null,
    settings: Settings,
    speed: boolean,
  ): Promise<TestResult> {
    const isChain = "nodeIds" in subject;
    const result: TestResult = {
      subjectId: subject.id,
      kind: isChain ? "chain" : "node",
      sourceId: source?.id || "local",
      latencyMs: null,
      speedMBps: null,
      error: null,
      testedAt: new Date().toISOString(),
    };
    try {
      if (isChain) {
        result.hops = [];
        for (let i = 0; i < subject.nodeIds.length; i++) {
          const subset = subject.nodeIds.slice(0, i + 1);
          try {
            const measurement = await this.measure(
              i === 0 ? [nodes.find((n) => n.id === subset[0])!] : nodes,
              i === 0 ? undefined : { ...subject, nodeIds: subset },
              source,
              settings,
              false,
            );
            result.hops.push({
              nodeId: subset[i],
              ok: true,
              state: "success",
              latencyMs: measurement.latencyMs,
              error: null,
            });
          } catch (e) {
            result.hops.push({
              nodeId: subset[i],
              ok: false,
              state: "failed",
              latencyMs: null,
              error: String(e),
            });
            throw new Error(`第 ${i + 1} 跳失败：${String(e)}`);
          }
        }
        Object.assign(
          result,
          await this.measure(nodes, subject, source, settings, speed),
        );
      } else
        Object.assign(
          result,
          await this.measure([subject], undefined, source, settings, speed),
        );
    } catch (e) {
      result.error = String(e);
      if (isChain) {
        result.hops ??= [];
        for (const nodeId of subject.nodeIds.slice(result.hops.length)) {
          result.hops.push({ nodeId, ok: false, state: "blocked", latencyMs: null, error: "未测试：前一跳未建立" });
        }
      }
    }
    return result;
  }
}

