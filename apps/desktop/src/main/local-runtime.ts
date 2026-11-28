import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  writeFile,
  mkdir,
  chmod,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { createServer, createConnection, type AddressInfo } from "node:net";
import { singboxConfig, type Chain, type ProxyNode } from "@gungun/domain";
import { createCoreReadiness } from "./core-readiness";
const exec = promisify(execFile);
export interface ActiveProxy {
  kind: "node" | "chain";
  id: string;
}
export interface RuntimeStatus {
  state: "stopped" | "starting" | "running" | "switching" | "error";
  port: number;
  active: ActiveProxy | null;
  error: string;
  logs: string[];
  version: string;
}
export async function availablePort(port = 0) {
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(port, "127.0.0.1", resolve),
  );
  const bound = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return bound;
}
export function redactLog(line: string, secrets: string[] = []) {
  for (const secret of secrets
    .filter((s) => s.length > 2)
    .sort((a, b) => b.length - a.length))
    line = line.split(secret).join("[redacted]");
  return line
    .replace(
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
      "[uuid]",
    )
    .replace(
      /((?:password|token|private_key|psk|uuid)["'\s:=]+)[^\s,}"']+/gi,
      "$1[redacted]",
    );
}
interface Running {
  child: ChildProcess;
  dir: string;
  config: Record<string, unknown>;
  stopProbe: () => Promise<void>;
  active: ActiveProxy;
  port: number;
  secrets: string[];
  intentional: boolean;
  exited: Promise<void>;
}
export class LocalRuntime {
  private running?: Running;
  private queue: Promise<unknown> = Promise.resolve();
  private status: RuntimeStatus = {
    state: "stopped",
    port: 10808,
    active: null,
    error: "",
    logs: [],
    version: "",
  };
  private initialized = false;
  onUnexpected: () => Promise<void> = async () => {};
  constructor(
    private core: () => Promise<string>,
    private directory: string,
    private notify = () => {},
    private supervisor?: string,
    private verifyURL?: () => string,
  ) {}
  snapshot(): RuntimeStatus {
    return { ...this.status, logs: [...this.status.logs] };
  }
  exclusive<T>(job: () => Promise<T>): Promise<T> {
    const task = this.queue.then(job);
    this.queue = task.catch(() => {});
    return task;
  }
  start(
    active: ActiveProxy,
    nodes: ProxyNode[],
    chain: Chain | undefined,
    port: number,
  ) {
    return this.exclusive(() => this.switch(active, nodes, chain, port));
  }
  private emit() {
    this.notify();
  }
  async initialize() {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith("run-"))
        await rm(join(this.directory, entry.name), {
          recursive: true,
          force: true,
        });
    }
    this.initialized = true;
  }
  async check() {
    const path = await this.core();
    const { stdout } = await exec(path, ["version"], {
      timeout: 10000,
      maxBuffer: 65536,
    });
    if (!/^sing-box version 1\.14\.4(?:\s|$)/m.test(stdout))
      throw new Error("本机核心必须为 sing-box 1.14.4");
    this.status.version = "1.14.4";
    this.emit();
    return path;
  }
  private async prepare(
    config: Record<string, unknown>,
    active: ActiveProxy,
    port: number,
    secrets: string[],
  ) {
    await this.initialize();
    const core = await this.check();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const dir = await mkdtemp(join(this.directory, "run-"));
    let probe: Awaited<ReturnType<typeof createCoreReadiness>> | undefined;
    try {
      const runtimeConfig = structuredClone(config);
      probe = await createCoreReadiness(runtimeConfig);
      await writeFile(join(dir, "config.json"), JSON.stringify(runtimeConfig), {
        mode: 0o600,
      });
      await exec(core, ["check", "-D", dir, "-c", join(dir, "config.json")], {
        timeout: 15000,
        maxBuffer: 65536,
      }).catch(() => {
        throw new Error("sing-box 配置校验失败；当前正常代理保持运行");
      });
      return {
        core,
        dir,
        config,
        stopProbe: probe.close,
        waitReady: probe.wait,
        active,
        port,
        secrets,
      };
    } catch (error) {
      await probe?.close();
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  private async launch(prepared: Awaited<ReturnType<LocalRuntime["prepare"]>>) {
    const args = [
      "run",
      "--disable-color",
      "-D",
      prepared.dir,
      "-c",
      join(prepared.dir, "config.json"),
    ];
    const child = this.supervisor
      ? spawn(process.execPath, [this.supervisor, prepared.core, ...args], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(prepared.core, args, { stdio: ["pipe", "pipe", "pipe"] });
    const run: Running = {
      ...prepared,
      child,
      intentional: false,
      exited: Promise.resolve(),
    };
    let exited = false;
    run.exited = new Promise<void>((resolve) => {
      child.once("close", () => {
        exited = true;
        resolve();
      });
      child.once("error", () => {
        exited = true;
        resolve();
      });
    });
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream?.on("data", (b: Buffer) => {
        pending += b.toString();
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        // Core logs are line-based; keep fragments together so split credentials are redacted.
        if (lines.length) {
          this.status.logs = [
            ...this.status.logs,
            ...lines.map((line) => redactLog(line + "\n", prepared.secrets)),
          ].slice(-160);
          this.emit();
        }
        if (pending.length > 65536)
          pending = "[oversized core log line omitted]";
      });
      stream?.on("end", () => {
        if (pending) {
          this.status.logs = [
            ...this.status.logs,
            redactLog(pending, prepared.secrets),
          ].slice(-160);
          this.emit();
        }
      });
    }
    void run.exited.then(async () => {
      if (run.intentional || this.running !== run) return;
      this.running = undefined;
      this.status.state = "error";
      this.status.error = "本机 sing-box 意外退出";
      this.emit();
      try {
        await this.onUnexpected();
      } catch (error) {
        this.status.error += `；网络恢复失败：${String(error)}`;
      }
      await prepared.stopProbe();
      await rm(prepared.dir, { recursive: true, force: true });
      this.emit();
    });
    try {
      await prepared.waitReady(() => exited);
      // The private direct probe checks routing independently from an unreachable node.
      const deadline = Date.now() + 5000;
      while (true) {
        if (exited)
          throw new Error("sing-box 启动失败，请查看已脱敏的运行日志");
        try {
          await this.socksGreeting(prepared.port);
          break;
        } catch {
          if (Date.now() >= deadline) throw new Error("本机 mixed 端口未就绪");
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      if (this.verifyURL) {
        await exec(
          "/usr/bin/curl",
          [
            "--silent",
            "--fail",
            "--max-time",
            "15",
            "--noproxy",
            "",
            "--proxy",
            `socks5h://127.0.0.1:${prepared.port}`,
            "--output",
            "/dev/null",
            "--",
            this.verifyURL(),
          ],
          { timeout: 17000, maxBuffer: 8192 },
        ).catch(() => {
          throw new Error("节点真实代理连接验证失败");
        });
      }
      if (exited) throw new Error("核心在启动验证期间退出");
      return run;
    } catch (error) {
      await this.dispose(run);
      throw error;
    }
  }
  private socksGreeting(port: number) {
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let response = Buffer.alloc(0);
      socket.setTimeout(250, () => socket.destroy(new Error("SOCKS 握手超时")));
      socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
      socket.on("data", (b) => {
        response = Buffer.concat([response, b]);
        if (response.length < 2) return;
        socket.destroy();
        if (response[0] === 5 && response[1] === 0) resolve();
        else reject(new Error("mixed inbound 握手失败"));
      });
      socket.once("error", reject);
    });
  }
  private async dispose(run: Running) {
    run.intentional = true;
    run.child.stdin?.end();
    run.child.kill("SIGTERM");
    const timer = setTimeout(() => run.child.kill("SIGKILL"), 2500);
    await run.exited;
    clearTimeout(timer);
    await run.stopProbe();
    await rm(run.dir, { recursive: true, force: true });
  }
  private async switch(
    active: ActiveProxy,
    nodes: ProxyNode[],
    chain: Chain | undefined,
    port: number,
  ) {
    const base = singboxConfig(nodes, chain, port) as Record<string, unknown>;
    const secrets = nodes.flatMap((n) => [
      n.password,
      n.uuid,
      n.obfsPassword,
      n.publicKey,
    ]);
    const old = this.running;
    this.status.state = old ? "switching" : "starting";
    this.status.error = "";
    this.emit();
    let candidate: Awaited<ReturnType<LocalRuntime["prepare"]>> | undefined;
    let trial: Running | undefined;
    try {
      // Validate and exercise a candidate on a separate port before interrupting the working core.
      const trialPort = await availablePort();
      trial = await this.launch(
        await this.prepare(
          singboxConfig(nodes, chain, trialPort) as Record<string, unknown>,
          active,
          trialPort,
          secrets,
        ),
      );
      await this.dispose(trial);
      trial = undefined;
      candidate = await this.prepare(base, active, port, secrets);
      if (!old || old.port !== port) await availablePort(port);
      if (old) {
        old.intentional = true;
        await this.dispose(old);
        this.running = undefined;
      }
      const run = await this.launch(candidate);
      candidate = undefined;
      this.running = run;
      this.status = {
        ...this.status,
        state: "running",
        active,
        port,
        error: "",
      };
      this.emit();
      return this.snapshot();
    } catch (error) {
      if (trial) await this.dispose(trial);
      if (candidate) {
        await candidate.stopProbe();
        await rm(candidate.dir, { recursive: true, force: true });
      }
      this.status.error = String(
        error instanceof Error ? error.message : error,
      );
      if (old && this.running !== old) {
        try {
          // Old files were removed only after keeping the in-memory config and secrets.
          const restored = await this.launch(
            await this.prepare(
              structuredClone(old.config),
              old.active,
              old.port,
              old.secrets,
            ),
          );
          this.running = restored;
          this.status.active = old.active;
          this.status.port = old.port;
        } catch (restoreError) {
          this.status.error += `；旧配置恢复失败：${String(restoreError)}`;
          await this.onUnexpected().catch((e) => {
            this.status.error += `；网络恢复失败：${String(e)}`;
          });
        }
      }
      this.status.state = this.running ? "running" : "error";
      this.emit();
      throw new Error(this.status.error);
    }
  }
  stop() {
    return this.exclusive(async () => {
      if (this.running) {
        const run = this.running;
        this.running = undefined;
        await this.dispose(run);
      }
      this.status.state = "stopped";
      this.status.active = null;
      this.emit();
    });
  }
}
