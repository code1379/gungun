import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  chainSchema,
  nodeSchema,
  resolveTag,
  settingsSchema,
  tagSchema,
  validateChain,
  validateVpsGraph,
  vpsSchema,
  type Chain,
  type ProxyNode,
  type Settings,
  type Snapshot,
  type Tag,
  type Task,
  type TestResult,
  type VPS,
} from "@gungun/domain";
type Kind = "vps" | "nodes" | "tags" | "chains" | "tasks";
export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO migrations VALUES(1);
 CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL CHECK(json_valid(data)));
 CREATE TABLE IF NOT EXISTS results(kind TEXT NOT NULL,subject_id TEXT NOT NULL,source_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(kind,subject_id,source_id));
 CREATE TABLE IF NOT EXISTS host_keys(address TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
 `);
    for (const t of this.all<Task>("tasks"))
      if (t.state === "running" || t.state === "queued")
        this.putRaw("tasks", {
          ...t,
          state: "interrupted",
          error: "应用退出，任务未完成；请检查 VPS 状态后重试",
          updatedAt: new Date().toISOString(),
        });
  }
  all<T>(kind: Kind): T[] {
    return this.db
      .prepare("SELECT data FROM objects WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(r.data as string) as T);
  }
  get<T>(kind: Kind, id: string): T {
    const row = this.db
      .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
      .get(kind, id);
    if (!row) throw new Error("记录不存在");
    return JSON.parse(row.data as string) as T;
  }
  putRaw<T extends { id: string }>(kind: Kind, item: T): T {
    this.db
      .prepare(
        "INSERT INTO objects(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, item.id, JSON.stringify(item));
    return item;
  }
  transaction<T>(fn: () => T): T {
    const name = `nested_${this.depth++}`;
    const outer = this.depth === 1;
    this.db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    try {
      const r = fn();
      this.db.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
      return r;
    } catch (e) {
      this.db.exec(outer ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${name}`);
      if (!outer) this.db.exec(`RELEASE SAVEPOINT ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
  saveVps(input: unknown) {
    const v = vpsSchema.parse(input);
    validateVpsGraph([...this.all<VPS>("vps").filter((x) => x.id !== v.id), v]);
    return this.transaction(() => {
      this.putRaw("vps", v);
      this.putRaw(
        "tags",
        tagSchema.parse({ id: `vps-${v.id}`, name: v.name, kind: "vps" }),
      );
      return v;
    });
  }
  saveNode(input: unknown) {
    const n = nodeSchema.parse(input);
    const t = this.get<Tag>("tags", n.tagId);
    if (t.kind === "aggregate") throw new Error("聚合组不能直接保存节点");
    return this.putRaw("nodes", n);
  }
  saveTag(input: unknown) {
    const t = tagSchema.parse(input);
    if (t.id === "all" || t.id === "chains") throw new Error("保留 Tag");
    const list = [...this.all<Tag>("tags").filter((x) => x.id !== t.id), t];
    resolveTag(t.id, [], list);
    return this.putRaw("tags", t);
  }
  saveChain(input: unknown) {
    const c = chainSchema.parse(input);
    validateChain(c, this.all("nodes"));
    return this.putRaw("chains", c);
  }
  affectedChains(nodeId: string) {
    return this.all<Chain>("chains").filter((c) => c.nodeIds.includes(nodeId));
  }
  remove(
    kind: "vps" | "nodes" | "tags" | "chains",
    id: string,
    confirmAffected = false,
  ) {
    return this.transaction(() => {
      if (kind === "nodes") {
        const chains = this.affectedChains(id);
        if (chains.length && !confirmAffected)
          throw new Error(
            `节点被链路引用：${chains.map((c) => c.name).join("、")}。确认后将同时删除这些链路`,
          );
        for (const c of chains) this.remove("chains", c.id);
        this.db
          .prepare("DELETE FROM results WHERE kind=? AND subject_id=?")
          .run("node", id);
      }
      if (kind === "chains")
        this.db
          .prepare("DELETE FROM results WHERE kind=? AND subject_id=?")
          .run("chain", id);
      if (kind === "vps") {
        if (this.all<VPS>("vps").some((v) => v.jumpId === id))
          throw new Error("该 VPS 正被用作跳板机");
        this.remove("tags", `vps-${id}`, confirmAffected);
      }
      if (kind === "tags") {
        for (const n of this.all<ProxyNode>("nodes").filter(
          (n) => n.tagId === id,
        ))
          this.remove("nodes", n.id, confirmAffected);
        for (const t of this.all<Tag>("tags").filter((t) =>
          t.tagIds.includes(id),
        ))
          this.putRaw("tags", {
            ...t,
            tagIds: t.tagIds.filter((x) => x !== id),
          });
      }
      this.db
        .prepare("DELETE FROM objects WHERE kind=? AND id=?")
        .run(kind, id);
    });
  }
  settings(): Settings {
    const r = this.db.prepare("SELECT data FROM settings WHERE id=1").get();
    return settingsSchema.parse(r ? JSON.parse(r.data as string) : {});
  }
  saveSettings(input: unknown) {
    const s = settingsSchema.parse(input);
    this.db
      .prepare(
        "INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify(s));
    return s;
  }
  result(r: TestResult) {
    this.db
      .prepare(
        "INSERT INTO results(kind,subject_id,source_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,subject_id,source_id) DO UPDATE SET data=excluded.data",
      )
      .run(r.kind, r.subjectId, r.sourceId, JSON.stringify(r));
  }
  results(): TestResult[] {
    return this.db
      .prepare("SELECT data FROM results")
      .all()
      .map((r) => JSON.parse(r.data as string) as TestResult);
  }
  sync(vpsId: string, input: unknown) {
    const data = nodeSchema.array().parse(input);
    const tagId = `vps-${vpsId}`;
    this.get<VPS>("vps", vpsId);
    if (
      data.some(
        (n) => n.vpsId !== vpsId || n.tagId !== tagId || n.source !== "vps",
      )
    )
      throw new Error("远程导出不属于目标 VPS");
    return this.transaction(() => {
      const incoming = new Set(data.map((n) => n.id));
      for (const n of this.all<ProxyNode>("nodes").filter(
        (n) => n.vpsId === vpsId,
      ))
        if (!incoming.has(n.id)) this.remove("nodes", n.id, true);
      for (const n of data) this.saveNode(n);
      return data.length;
    });
  }
  importNodes(tagId: string, nodes: ProxyNode[], replace: boolean) {
    return this.transaction(() => {
      const old = this.all<ProxyNode>("nodes").filter((n) => n.tagId === tagId);
      const next: ProxyNode[] = [];
      for (const n of nodes) {
        const match = old.find(
          (o) =>
            o.protocol === n.protocol &&
            o.address === n.address &&
            o.port === n.port &&
            o.uuid === n.uuid &&
            o.password === n.password,
        );
        next.push({ ...n, id: match?.id || n.id, tagId });
      }
      if (replace) {
        const ids = new Set(next.map((n) => n.id));
        for (const n of old)
          if (!ids.has(n.id)) this.remove("nodes", n.id, true);
      }
      for (const n of next) this.saveNode(n);
      return next.length;
    });
  }
  fingerprint(address: string) {
    return this.db
      .prepare("SELECT fingerprint FROM host_keys WHERE address=?")
      .get(address)?.fingerprint as string | undefined;
  }
  trust(address: string, fp: string) {
    this.db
      .prepare(
        "INSERT INTO host_keys VALUES(?,?) ON CONFLICT(address) DO UPDATE SET fingerprint=excluded.fingerprint",
      )
      .run(address, fp);
  }
  snapshot(): Snapshot {
    return {
      vps: this.all("vps"),
      nodes: this.all("nodes"),
      chains: this.all("chains"),
      tags: this.all("tags"),
      tasks: this.all("tasks"),
      results: this.results(),
      settings: {
        ...this.settings(),
        cloudflareKey: this.settings().cloudflareKey ? "********" : "",
      },
    };
  }
  task(type: string, vpsId: string | null): Task {
    const now = new Date().toISOString();
    return this.putRaw("tasks", {
      id: randomUUID(),
      type,
      vpsId,
      state: "queued",
      progress: 0,
      steps: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  close() {
    this.db.close();
  }
}
