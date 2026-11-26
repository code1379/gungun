import { spawn, execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import {
  mihomoConfig,
  type Chain,
  type ProxyNode,
  type Settings,
  type TestResult,
  type VPS,
} from "@gungun/domain";
import type { SSH } from "./ssh";
const exec = promisify(execFile);
export interface Measurement {
  latencyMs: number;
  speedMBps: number | null;
  error: null;
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
async function ready(port: number, exited: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (exited()) throw new Error("Mihomo 启动失败，请检查协议参数");
    const ok = await new Promise<boolean>((r) => {
      const c = net.connect(port, "127.0.0.1");
      c.once("connect", () => {
        c.destroy();
        r(true);
      });
      c.once("error", () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Mihomo 启动超时");
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
    const config = mihomoConfig(nodes, chain, await freePort());
    if (process.env.GUNGUN_CORE_DEBUG) config["log-level"] = "debug";
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
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      child = spawn(this.corePath, ["-d", dir, "-f", path], {
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
      await ready(config["mixed-port"], () => exited);
      if (processError) throw processError;
      const port = config["mixed-port"];
      const common = [
        "--silent",
        "--show-error",
        "--fail",
        "--proxy",
        `http://127.0.0.1:${port}`,
        "--noproxy",
        "",
        "--max-time",
        String(settings.timeoutMs / 1000),
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code} %{time_total} %{size_download}",
      ];
      const { stdout } = await exec(
        "/usr/bin/curl",
        [...common, "--", settings.latencyUrl],
        {
          timeout: settings.timeoutMs + 2000,
          env: {
            ...process.env,
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
          },
        },
      );
      const [code, seconds] = stdout.trim().split(" ");
      if (Number(code) < 200 || Number(code) >= 400)
        throw new Error(`延迟请求返回 HTTP ${code}`);
      const latencyMs = Number(seconds) * 1000;
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
      throw new Error(
        `${String(e)}${runtimeLog ? `\n核心日志：${runtimeLog}` : ""}`,
      );
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
