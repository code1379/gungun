import { z } from "zod";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { dialog } from "electron";
import {
  chainSchema,
  exportBase64,
  exportMihomo,
  hostSchema,
  nodeSchema,
  parseSubscription,
  resolveTag,
  serviceSchema,
  settingsSchema,
  tagSchema,
  vpsSchema,
  websiteSchema,
  type Chain,
  type ProxyNode,
  type Tag,
  type Task,
  type VPS,
} from "@gungun/domain";
import type { Store } from "./store";
import { SSH } from "./ssh";
import { TaskCenter, pooled, ConcurrencyGate } from "./tasks";
import { Cloudflare } from "./cloudflare";
import { Orchestrator } from "./orchestrator";
import { Benchmark } from "./benchmark";
const id = z.string().min(1).max(200);
export class API {
  private testGate: ConcurrencyGate;
  readonly ssh: SSH;
  readonly tasks: TaskCenter;
  readonly orchestrator: Orchestrator;
  readonly benchmark: Benchmark;
  constructor(
    readonly store: Store,
    private notify: () => void,
    resources: string,
    dataDir: string,
    private openWindow: (type: string, id: string) => void,
  ) {
    this.testGate = new ConcurrencyGate(() => store.settings().concurrency);
    this.ssh = new SSH(store);
    this.tasks = new TaskCenter(store, notify);
    this.orchestrator = new Orchestrator(
      store,
      this.ssh,
      resources,
      notify,
      join(dataDir, "acme"),
    );
    this.benchmark = new Benchmark(
      join(
        resources,
        `mihomo-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`,
      ),
      this.ssh,
    );
  }
  async invoke(operation: string, input: unknown): Promise<unknown> {
    const s = this.store;
    let value: unknown;
    switch (operation) {
      case "snapshot":
        return s.snapshot();
      case "newVps":
        return vpsSchema.parse({
          id: randomUUID(),
          name: "新 VPS",
          kind: "public",
          address: "localhost",
          publicAddress: "127.0.0.1",
          username: "root",
          auth: "key",
          keyPath:
            s.settings().sshKeyPath ||
            join(homedir(), ".ssh", "gungun", "id_ed25519"),
          namespace: randomBytes(4).toString("hex"),
        });
      case "saveVps":
        value = s.saveVps(input);
        break;
      case "saveNode":
        value = s.saveNode(input);
        break;
      case "saveTag":
        value = s.saveTag(input);
        break;
      case "saveChain":
        value = s.saveChain(input);
        break;
      case "delete": {
        const q = z
          .object({
            kind: z.enum(["vps", "nodes", "tags", "chains"]),
            id,
            confirmAffected: z.boolean().default(false),
          })
          .parse(input);
        value = s.remove(q.kind, q.id, q.confirmAffected);
        break;
      }
      case "affectedChains":
        return s.affectedChains(id.parse(input));
      case "saveSettings": {
        const q = settingsSchema.parse(input);
        if (q.cloudflareKey === "********")
          q.cloudflareKey = s.settings().cloudflareKey;
        value = s.saveSettings(q);
        value = { ...q, cloudflareKey: q.cloudflareKey ? "********" : "" };
        break;
      }
      case "zones":
        return new Cloudflare(s.settings()).zones();
      case "tailscale":
        return this.ssh.localTailscale();
      case "generateKey": {
        const path = join(
          homedir(),
          ".ssh",
          "gungun",
          `id_ed25519_${Date.now()}`,
        );
        const publicKey = await this.ssh.generateKey(path);
        s.saveSettings({ ...s.settings(), sshKeyPath: path });
        this.notify();
        return { path, publicKey };
      }
      case "sshTest": {
        const v = vpsSchema.parse(input);
        return this.ssh.test(v);
      }
      case "trustHost": {
        const q = z
          .object({
            address: z.string().min(1).max(300),
            fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
          })
          .parse(input);
        s.trust(q.address, q.fingerprint);
        return true;
      }
      case "sshConfig":
        return this.ssh.exportConfig(s.get<VPS>("vps", id.parse(input)));
      case "openWindow": {
        const q = z
          .object({ type: z.enum(["terminal", "logs", "task"]), id })
          .parse(input);
        if (q.type === "task") s.get("tasks", q.id);
        else s.get("vps", q.id);
        this.openWindow(q.type, q.id);
        return true;
      }
      case "installFq": {
        const v = s.get<VPS>("vps", id.parse(input));
        return this.tasks.submit("安装 fq 与核心", v.id, (step) =>
          this.orchestrator.install(v, step),
        );
      }
      case "syncVps": {
        const v = s.get<VPS>("vps", id.parse(input));
        return this.tasks.submit("手动同步 VPS 节点", v.id, (step) =>
          this.orchestrator.sync(v, step),
        );
      }
      case "deploy": {
        const q = z
          .object({
            vpsId: id,
            service: serviceSchema.optional(),
            website: websiteSchema.optional(),
          })
          .refine((q) => !!q.service !== !!q.website)
          .parse(input);
        const v = s.get<VPS>("vps", q.vpsId);
        return this.tasks.submit(
          q.service ? "部署协议服务" : "部署网站",
          v.id,
          (step) => this.orchestrator.deploy(v, q.service, q.website, step),
        );
      }
      case "remoteRead": {
        const q = z
          .object({
            vpsId: id,
            action: z.enum(["status", "config", "list", "log", "backups"]),
            unit: z
              .enum(["gungun-sing-box", "gungun-caddy", "gungun-tunnel"])
              .optional(),
          })
          .parse(input);
        const v = s.get<VPS>("vps", q.vpsId);
        if (q.action === "backups") {
          const out = await this.ssh.run(
            v,
            `${v.username === "root" ? "" : "sudo -n "}/usr/local/bin/fq backup list --json`,
          );
          return JSON.parse(out) as unknown;
        }
        return this.ssh.fq(
          v,
          q.action === "log" ? `log ${q.unit || "gungun-sing-box"}` : q.action,
        );
      }
      case "remoteAction": {
        const q = z
          .object({
            vpsId: id,
            action: z.enum([
              "restart",
              "backup",
              "restore",
              "warp install",
              "warp connect",
              "warp disconnect",
              "warp status",
              "renew",
              "core update sing-box",
              "core update mihomo",
              "core update cloudflared",
              "core update caddy",
            ]),
            backupId: z
              .string()
              .regex(/^[0-9TZ.]+$/)
              .optional(),
          })
          .parse(input);
        const v = s.get<VPS>("vps", q.vpsId);
        return this.tasks.submit(q.action, v.id, (step) =>
          step(q.action, async () => {
            if (q.action === "renew")
              return this.orchestrator.certificates.issue(v);
            if (q.action === "restore") {
              if (!q.backupId) throw new Error("请选择备份");
              return this.ssh.run(
                v,
                `${v.username === "root" ? "" : "sudo -n "}/usr/local/bin/fq restore '${q.backupId}' --json`,
              );
            }
            return this.ssh.fq(v, q.action);
          }),
        );
      }
      case "removeRemote": {
        const q = z
          .object({ vpsId: id, kind: z.enum(["service", "website"]), id })
          .parse(input);
        const v = s.get<VPS>("vps", q.vpsId);
        return this.tasks.submit("删除远程服务", v.id, (step) =>
          this.orchestrator.remove(v, q.kind, q.id, step),
        );
      }
      case "importSubscription": {
        const q = z
          .object({
            tagId: id,
            text: z
              .string()
              .min(1)
              .max(8 * 1024 * 1024),
            replace: z.boolean().default(false),
          })
          .parse(input);
        s.get<Tag>("tags", q.tagId);
        value = s.importNodes(
          q.tagId,
          parseSubscription(q.text, q.tagId, randomUUID),
          q.replace,
        );
        break;
      }
      case "updateSubscription": {
        const tag = s.get<Tag>("tags", id.parse(input));
        if (tag.kind !== "subscription") throw new Error("请选择外部订阅");
        const url = z.url().parse(tag.url);
        if (!/^https?:/.test(url)) throw new Error("订阅地址仅支持 HTTP/HTTPS");
        return this.tasks.submit("更新外部订阅", null, (step) =>
          step("下载并原子更新订阅", async () => {
            const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!r.ok) throw new Error(`订阅 HTTP ${r.status}`);
            if (Number(r.headers.get("content-length")) > 8 * 1024 * 1024)
              throw new Error("订阅超过 8 MB");
            const reader = r.body!.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > 8 * 1024 * 1024) throw new Error("订阅超过 8 MB");
                chunks.push(value);
              }
            } finally {
              await reader.cancel();
            }
            s.importNodes(
              tag.id,
              parseSubscription(
                Buffer.concat(chunks).toString(),
                tag.id,
                randomUUID,
              ),
              true,
            );
            this.notify();
          }),
        );
      }
      case "export": {
        const q = z
          .object({ tagId: id, format: z.enum(["mihomo", "base64"]) })
          .parse(input);
        const chains = q.tagId === "chains" ? s.all<Chain>("chains") : [];
        const nodes =
          q.tagId === "chains"
            ? s.all<ProxyNode>("nodes")
            : resolveTag(q.tagId, s.all("nodes"), s.all("tags"));
        const content =
          q.format === "mihomo"
            ? exportMihomo(nodes, chains)
            : exportBase64(nodes, chains.length > 0);
        const result = await dialog.showSaveDialog({
          defaultPath: q.format === "mihomo" ? "gungun.yaml" : "gungun.txt",
          filters: [
            {
              name: "订阅文件",
              extensions: [q.format === "mihomo" ? "yaml" : "txt"],
            },
          ],
        });
        if (result.canceled || !result.filePath) return null;
        await writeFile(result.filePath, content, { mode: 0o600 });
        return result.filePath;
      }
      case "test": {
        const q = z
          .object({
            tagId: id,
            sourceIds: z.array(id).min(1).max(20),
            speed: z.boolean(),
            subjectIds: z.array(id).optional(),
          })
          .parse(input);
        const nodes = s.all<ProxyNode>("nodes");
        const subjects: (ProxyNode | Chain)[] =
          q.tagId === "chains"
            ? s.all("chains")
            : resolveTag(q.tagId, nodes, s.all("tags"));
        const selected = q.subjectIds
          ? subjects.filter((n) => q.subjectIds!.includes(n.id))
          : subjects;
        const sources = q.sourceIds.map((source) =>
          source === "local" ? null : s.get<VPS>("vps", source),
        );
        const jobs = selected.flatMap((subject) =>
          sources
            .filter(
              (source) =>
                !source ||
                ("nodeIds" in subject
                  ? !subject.nodeIds.some(
                      (n) => nodes.find((x) => x.id === n)?.vpsId === source.id,
                    )
                  : subject.vpsId !== source.id),
            )
            .map((source) => ({ subject, source })),
        );
        if (!jobs.length)
          throw new Error("没有可测试项，VPS 不能测试自己部署的节点");
        return this.tasks.submit(
          q.speed ? "多主机延迟和速度测试" : "真连接延迟测试",
          null,
          (step) =>
            step(
              `测试 ${jobs.length} 项，最大并发 ${s.settings().concurrency}`,
              () =>
                pooled(
                  jobs,
                  s.settings().concurrency,
                  async ({ subject, source }) => {
                    s.result(
                      await this.testGate.run(() =>
                        this.benchmark.test(
                          subject,
                          nodes,
                          source,
                          s.settings(),
                          q.speed,
                        ),
                      ),
                    );
                    this.notify();
                  },
                ),
            ),
        );
      }
      case "candidateIPs": {
        const r = await fetch("https://www.cloudflare.com/ips-v4", {
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error("候选 IP 获取失败");
        const ranges = (await r.text()).trim().split(/\s+/);
        const candidates: string[] = [];
        for (const range of ranges) {
          const [base, bits] = range.split("/");
          if (isIP(base) !== 4 || Number(bits) < 8 || Number(bits) > 32)
            throw new Error("无效 Cloudflare IP 段");
          const octets = base.split(".").map(Number);
          const integer = octets.reduce((a, n) => (a * 256 + n) >>> 0, 0);
          const span = 2 ** (32 - Number(bits));
          for (let i = 0; i < 3; i++) {
            const value =
              (integer +
                1 +
                Math.floor(Math.random() * Math.max(1, span - 2))) >>>
              0;
            candidates.push(
              [
                value >>> 24,
                (value >>> 16) & 255,
                (value >>> 8) & 255,
                value & 255,
              ].join("."),
            );
          }
        }
        return candidates;
      }
      case "optimize": {
        const q = z
          .object({
            nodeId: id,
            addresses: z.array(hostSchema).min(1).max(100),
            sourceId: id.default("local"),
          })
          .parse(input);
        const node = s.get<ProxyNode>("nodes", q.nodeId);
        if (node.access === "direct")
          throw new Error("优选 IP 仅用于 CDN 或 Argo 节点");
        const source =
          q.sourceId === "local" ? null : s.get<VPS>("vps", q.sourceId);
        if (source?.id === node.vpsId) throw new Error("VPS 不能测试自身节点");
        let taskId = "";
        taskId = this.tasks.submit("真实代理优选 IP", null, (step) =>
          step(`测试 ${q.addresses.length} 个候选地址`, async () => {
            const results: {
              address: string;
              latencyMs: number | null;
              speedMBps: number | null;
              error: string | null;
            }[] = [];
            await pooled(
              q.addresses,
              s.settings().concurrency,
              async (address) => {
                try {
                  const r = await this.testGate.run(() =>
                    this.benchmark.measure(
                      [{ ...node, address }],
                      undefined,
                      source,
                      s.settings(),
                      true,
                    ),
                  );
                  results.push({ address, ...r });
                } catch (e) {
                  results.push({
                    address,
                    latencyMs: null,
                    speedMBps: null,
                    error: String(e),
                  });
                }
                const task = s.get<Task>("tasks", taskId);
                s.putRaw("tasks", { ...task, output: results });
                this.notify();
              },
            );
          }),
        );
        return taskId;
      }
      case "applyIP": {
        const q = z.object({ nodeId: id, address: hostSchema }).parse(input);
        value = s.saveNode({
          ...s.get<ProxyNode>("nodes", q.nodeId),
          address: q.address,
        });
        break;
      }
      case "chooseKey": {
        const result = await dialog.showOpenDialog({
          title: "选择 SSH 私钥",
          properties: ["openFile"],
        });
        return result.canceled ? null : result.filePaths[0];
      }
      case "importFile": {
        const result = await dialog.showOpenDialog({
          properties: ["openFile"],
          filters: [{ name: "节点或订阅", extensions: ["txt", "yaml", "yml"] }],
        });
        if (result.canceled) return null;
        const content = await readFile(result.filePaths[0], "utf8");
        if (content.length > 8 * 1024 * 1024) throw new Error("文件超过 8 MB");
        return content;
      }
      case "exportData": {
        const result = await dialog.showSaveDialog({
          defaultPath: "gungun-backup.json",
        });
        if (result.canceled || !result.filePath) return null;
        const data = { ...s.snapshot(), settings: s.settings() };
        await writeFile(result.filePath, JSON.stringify(data, null, 2), {
          mode: 0o600,
        });
        return result.filePath;
      }
      case "importData": {
        const result = await dialog.showOpenDialog({
          properties: ["openFile"],
          filters: [{ name: "Gungun backup", extensions: ["json"] }],
        });
        if (result.canceled) return null;
        const raw = await readFile(result.filePaths[0], "utf8");
        const data = z
          .object({
            vps: z.array(vpsSchema),
            nodes: z.array(nodeSchema),
            tags: z.array(tagSchema),
            chains: z.array(chainSchema),
            settings: settingsSchema,
          })
          .parse(JSON.parse(raw));
        s.transaction(() => {
          for (const v of data.vps) s.putRaw("vps", v);
          for (const v of data.vps) s.saveVps(v);
          for (const t of data.tags) s.putRaw("tags", t);
          for (const t of data.tags) s.saveTag(t);
          for (const n of data.nodes) s.saveNode(n);
          for (const c of data.chains) s.saveChain(c);
          s.saveSettings(data.settings);
        });
        value = true;
        break;
      }
      default:
        throw new Error("不支持的操作");
    }
    this.notify();
    return value;
  }
  async renewDue() {
    for (const v of this.store.all<VPS>("vps"))
      if (v.zoneId) {
        try {
          const state = await this.ssh.state(v);
          if (
            state.certificate &&
            Date.parse(state.certificate.notAfter) < Date.now() + 30 * 86400000
          )
            this.tasks.submit("自动续期证书", v.id, (step) =>
              step("续期并部署证书", () =>
                this.orchestrator.certificates.issue(v),
              ),
            );
        } catch {
          /* 离线 VPS 下次检查，任务由用户手动重试 */
        }
      }
  }
}
