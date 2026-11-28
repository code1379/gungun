import { spawn } from "node:child_process";
import { z } from "zod";
import { readMacNetworkServices } from "./network-services";
import type { Chain, ProxyNode } from "@gungun/domain";
import type { ActiveProxy, LocalRuntime } from "./local-runtime";
export interface NetworkService {
  id: string;
  name: string;
  active: boolean;
  proxies: Record<string, unknown>;
}
export interface SystemProxyStatus {
  enabled: boolean;
  conflict: boolean;
  serviceId: string;
  port: number;
  error: string;
}
const systemStatusSchema = z.object({
  enabled: z.boolean(),
  conflict: z.boolean(),
  serviceId: z.string(),
  port: z.number().int().min(0).max(65535),
  error: z.string(),
});
const networkServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  active: z.boolean(),
  proxies: z.record(z.string(), z.unknown()),
});
export interface ProxyAdapter {
  request<T>(action: string, input?: Record<string, unknown>): Promise<T>;
  authorize(): Promise<unknown>;
}
export class MacProxyAdapter implements ProxyAdapter {
  constructor(
    private binary: string | undefined,
    private readServices: () => Promise<
      NetworkService[]
    > = readMacNetworkServices,
  ) {}
  private call<T>(mode: string, input?: unknown): Promise<T> {
    if (process.platform !== "darwin")
      return Promise.reject(
        new Error("系统代理仅支持 macOS；当前平台无法验收"),
      );
    if (!this.binary)
      return Promise.reject(
        new Error(
          "系统代理需要安装已签名的 Gungun.app；开发模式可使用本机核心，但不能注册特权辅助程序",
        ),
      );
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary!, [mode], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("系统代理辅助程序请求超时"));
      }, 20000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 2 * 1024 * 1024) child.kill();
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", () => {
        clearTimeout(timeout);
        try {
          const reply = JSON.parse(output) as {
            ok: boolean;
            value: T;
            error: string;
          };
          if (!reply.ok) throw new Error(reply.error);
          resolve(reply.value);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input || {}));
    });
  }
  request<T>(action: string, input: Record<string, unknown> = {}) {
    if (action === "services") return this.readServices() as Promise<T>;
    return this.call<T>("request", { ...input, action });
  }
  authorize() {
    return this.call("register");
  }
}
export class ProxyController {
  private queue: Promise<unknown> = Promise.resolve();
  private heartbeat?: ReturnType<typeof setInterval>;
  private independent = false;
  private leaseBusy = false;
  private status: SystemProxyStatus = {
    enabled: false,
    conflict: false,
    serviceId: "",
    port: 0,
    error: "",
  };
  constructor(
    readonly runtime: LocalRuntime,
    private adapter: ProxyAdapter,
    private notify = () => {},
  ) {
    runtime.onUnexpected = async () => {
      await this.restore();
    };
  }
  snapshot() {
    return { ...this.status };
  }
  private exclusive<T>(fn: () => Promise<T>) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  initialize() {
    return this.exclusive(async () => {
      try {
        await this.runtime.initialize();
        // A previous application session's lease must never be adopted silently.
        const status = await this.readStatus();
        this.status = status;
        if (status.enabled && !status.conflict) await this.restore();
      } catch (error) {
        this.status.error = String(
          error instanceof Error ? error.message : error,
        );
      }
      this.notify();
    });
  }
  private readStatus() {
    return this.adapter
      .request<unknown>("status")
      .then((value) => systemStatusSchema.parse(value));
  }
  services() {
    return this.adapter
      .request<unknown>("services")
      .then((value) => networkServiceSchema.array().parse(value));
  }
  async authorize() {
    const result = await this.adapter.authorize();
    if (
      result &&
      typeof result === "object" &&
      "status" in result &&
      result.status === "enabled"
    ) {
      this.status = await this.readStatus();
      this.notify();
    }
    return result;
  }
  private beginLease() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.leaseBusy) return;
      this.leaseBusy = true;
      void this.readStatus()
        .then(async (status) => {
          this.status = status;
          if (!status.enabled || status.conflict) {
            this.endLease();
            return;
          }
          const services = await this.services();
          const active = services.find((service) => service.active);
          if (active && active.id !== status.serviceId) {
            await this.restore();
            this.status.error =
              "活动网络服务已切换，已恢复之前的代理配置；请为当前网络重新开启";
            return;
          }
          await this.adapter.request("lease", {
            switching: ["starting", "switching"].includes(
              this.runtime.snapshot().state,
            ),
          });
        })
        .catch(async (error) => {
          this.status.error = String(
            error instanceof Error ? error.message : error,
          );
          this.endLease();
          try {
            await this.restore();
          } catch (restoreError) {
            this.status.error += `；恢复失败：${String(restoreError)}`;
          }
        })
        .finally(() => {
          this.leaseBusy = false;
          this.notify();
        });
    }, 2000);
    this.heartbeat.unref();
  }
  private endLease() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  private async restore() {
    this.endLease();
    try {
      await this.adapter.request("disable");
      const status = await this.readStatus();
      this.status = status;
      if (status.enabled || status.conflict)
        throw new Error(status.error || "恢复状态验证失败");
    } catch (error) {
      this.status.error = String(
        error instanceof Error ? error.message : error,
      );
      this.notify();
      throw error;
    }
    this.notify();
  }
  enable(
    active: ActiveProxy,
    nodes: ProxyNode[],
    chain: Chain | undefined,
    port: number,
    serviceId: string,
  ) {
    return this.exclusive(async () => {
      const current = await this.readStatus();
      this.status = current;
      if (current.conflict)
        throw new Error("系统代理存在外部修改冲突，请先在设置中核验");
      if (current.enabled) {
        if (current.serviceId === serviceId && current.port === port) return;
        throw new Error("请先关闭当前系统代理，再切换服务或端口");
      }
      const services = await this.services();
      if (
        !services.some((service) => service.id === serviceId && service.active)
      )
        throw new Error("请选择当前活动的网络服务");
      const alreadyRunning = this.runtime.snapshot().state === "running";
      if (
        !alreadyRunning ||
        JSON.stringify(this.runtime.snapshot().active) !==
          JSON.stringify(active) ||
        this.runtime.snapshot().port !== port
      )
        await this.runtime.start(active, nodes, chain, port);
      try {
        await this.adapter.request("enable", {
          serviceId,
          port,
        });
        const status = await this.readStatus();
        this.status = status;
        if (
          !status.enabled ||
          status.conflict ||
          status.serviceId !== serviceId ||
          status.port !== port
        )
          throw new Error("系统代理设置验证失败");
        this.beginLease();
        this.notify();
      } catch (error) {
        let rollback = "";
        try {
          await this.restore();
        } catch (e) {
          rollback = `；回滚失败：${String(e)}`;
        }
        // Keep a usable core while rollback is unresolved; the daemon keeps its recovery record.
        if (!rollback && !alreadyRunning && !this.independent)
          await this.runtime.stop();
        throw new Error(`${String(error)}${rollback}`);
      }
    });
  }
  disable() {
    return this.exclusive(async () => {
      await this.restore();
      if (!this.independent) await this.runtime.stop();
    });
  }
  private async changeCore(
    active: ActiveProxy,
    nodes: ProxyNode[],
    chain: Chain | undefined,
    port: number,
  ) {
    const managed = this.status.enabled && !this.status.conflict;
    if (managed) await this.adapter.request("beginSwitch");
    let failure: unknown;
    try {
      await this.runtime.start(active, nodes, chain, port);
    } catch (error) {
      failure = error;
    }
    if (managed) {
      try {
        await this.adapter.request("endSwitch");
      } catch (error) {
        this.status.error = `切换后系统代理监测恢复失败：${String(error)}`;
        this.notify();
        throw new Error(
          `${failure ? `${String(failure)}；` : ""}${this.status.error}`,
        );
      }
    }
    if (failure) throw failure;
  }
  start(
    active: ActiveProxy,
    nodes: ProxyNode[],
    chain: Chain | undefined,
    port: number,
  ) {
    return this.exclusive(async () => {
      if (this.status.enabled && this.status.port !== port)
        throw new Error("修改监听端口前请先关闭系统代理");
      await this.changeCore(active, nodes, chain, port);
      this.independent = true;
    });
  }
  switch(
    active: ActiveProxy,
    nodes: ProxyNode[],
    chain: Chain | undefined,
    port: number,
  ) {
    return this.exclusive(async () => {
      if (this.runtime.snapshot().state === "running") {
        if (this.status.enabled && this.status.port !== port)
          throw new Error("修改端口前请先关闭系统代理");
        await this.changeCore(active, nodes, chain, port);
      }
    });
  }
  stop() {
    return this.exclusive(async () => {
      if (this.status.enabled || this.status.conflict) await this.restore();
      this.independent = false;
      await this.runtime.stop();
    });
  }
  acknowledge(confirm: boolean) {
    return this.exclusive(async () => {
      z.literal(true).parse(confirm);
      await this.adapter.request("acknowledgeConflict", { confirm });
      this.status = await this.readStatus();
      this.notify();
    });
  }
  async shutdown() {
    await this.exclusive(async () => {
      try {
        if (this.status.enabled || this.status.conflict) await this.restore();
      } finally {
        this.endLease();
        await this.runtime.stop();
      }
    });
  }
}
