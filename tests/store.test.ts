import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../apps/desktop/src/main/store";
import { nodeSchema, vpsSchema, type Task } from "../packages/domain/src/index";
const stores: Store[] = [];
const paths: string[] = [];
function store() {
  const path = mkdtempSync(join(tmpdir(), "gungun-test-"));
  paths.push(path);
  const s = new Store(join(path, "db.sqlite"));
  stores.push(s);
  return s;
}
function vps() {
  return vpsSchema.parse({
    id: randomUUID(),
    name: "HK",
    kind: "public",
    address: "localhost",
    publicAddress: "127.0.0.1",
    username: "root",
    auth: "password",
    namespace: "a7k2p",
  });
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const path of paths.splice(0))
    rmSync(path, { recursive: true, force: true });
});
describe("SQLite 数据一致性", () => {
  it("主题默认跟随系统，三种偏好可以保存并在重启后恢复", () => {
    const s = store();
    expect(s.settings().theme).toBe("system");
    for (const theme of ["dark", "light", "system"] as const) {
      s.saveSettings({ ...s.settings(), theme });
      expect(s.snapshot().settings.theme).toBe(theme);
    }
    s.saveSettings({ ...s.settings(), theme: "light" });
    s.close();
    stores.pop();
    const reopened = new Store(join(paths[0], "db.sqlite"));
    stores.push(reopened);
    expect(reopened.settings().theme).toBe("light");
  });
  it("已有原始节点的分组不能直接转换为动态聚合", () => {
    const s = store();
    s.saveTag({ id: "manual", name: "manual", kind: "manual" });
    s.saveNode({
      id: "n",
      name: "n",
      protocol: "snell",
      address: "localhost",
      port: 12345,
      tagId: "manual",
    });
    expect(() =>
      s.saveTag({
        id: "manual",
        name: "aggregate",
        kind: "aggregate",
        tagIds: [],
      }),
    ).toThrow("原始节点");
    expect(s.all<{ kind: string }>("tags")[0].kind).toBe("manual");
    expect(s.all("nodes")).toHaveLength(1);
  });
  it("持久化 VPS 与独立 Tag，并限制文件权限", () => {
    const s = store();
    const v = vps();
    s.saveVps(v);
    expect(s.all("tags")).toHaveLength(1);
    expect(s.snapshot().vps[0]).toEqual(v);
    expect(statSync(join(paths[0], "db.sqlite")).mode & 0o777).toBe(0o600);
    s.saveSettings({ ...s.settings(), cloudflareKey: "private-key" });
    expect(s.snapshot().settings.cloudflareKey).toBe("********");
    expect(s.settings().cloudflareKey).toBe("private-key");
  });
  it("同步原子替换和链路引用更新，删除原节点须确认影响", () => {
    const s = store();
    const v = vps();
    s.saveVps(v);
    const make = (suffix: string) =>
      nodeSchema.parse({
        id: v.id + suffix,
        name: suffix,
        protocol: "snell",
        address: "localhost",
        port: 12345,
        password: "a-long-secret",
        vpsId: v.id,
        tagId: `vps-${v.id}`,
        source: "vps",
      });
    const a = make("a"),
      b = make("b");
    s.sync(v.id, [a, b]);
    const c = { id: randomUUID(), name: "chain", nodeIds: [a.id, b.id] };
    s.saveChain(c);
    expect(() => s.remove("nodes", a.id)).toThrow("引用");
    expect(s.all("nodes")).toHaveLength(2);
    s.sync(v.id, [{ ...a, port: 23456 }, b]);
    expect(s.get("chains", c.id)).toEqual(c);
    expect(s.get<typeof a>("nodes", a.id).port).toBe(23456);
    s.sync(v.id, [a]);
    expect(s.all("chains")).toHaveLength(0);
    expect(s.all("nodes")).toHaveLength(1);
  });
  it("导出数据不属于此 VPS 时拒绝，原数据不丢失", () => {
    const s = store();
    const v = vps();
    s.saveVps(v);
    const n = nodeSchema.parse({
      id: "n",
      name: "n",
      protocol: "snell",
      address: "localhost",
      port: 12345,
      tagId: `vps-${v.id}`,
      vpsId: v.id,
      source: "vps",
    });
    s.sync(v.id, [n]);
    expect(() => s.sync(v.id, [{ ...n, vpsId: "other" }])).toThrow("不属于");
    expect(s.all("nodes")).toHaveLength(1);
  });
  it("只保留每个主体、类型与测试来源的最新结果", () => {
    const s = store();
    const r = {
      subjectId: "a",
      kind: "node" as const,
      sourceId: "local",
      latencyMs: 1,
      speedMBps: null,
      error: null,
      testedAt: "now",
    };
    s.result(r);
    s.result({ ...r, latencyMs: 2 });
    s.result({ ...r, kind: "chain" });
    s.result({ ...r, sourceId: "vps" });
    expect(s.results()).toHaveLength(3);
    expect(
      s.results().find((r) => r.kind === "node" && r.sourceId === "local")
        ?.latencyMs,
    ).toBe(2);
  });
  it("重启时未完成任务标为中断", () => {
    const s = store();
    const task = s.task("deploy", "vps");
    s.putRaw("tasks", { ...task, state: "running" });
    s.close();
    stores.pop();
    const reopened = new Store(join(paths[0], "db.sqlite"));
    stores.push(reopened);
    expect(reopened.get<Task>("tasks", task.id).state).toBe("interrupted");
  });
  it("订阅更新保留已有 ID，已删除节点移除受影响链路", () => {
    const s = store();
    s.saveTag({
      id: "sub",
      name: "sub",
      kind: "subscription",
      tagIds: [],
      url: "https://example.com",
    });
    const a = nodeSchema.parse({
        id: "a",
        name: "A",
        protocol: "anytls",
        address: "localhost",
        port: 12345,
        tagId: "sub",
        source: "subscription",
      }),
      b = { ...a, id: "b", port: 12346 };
    s.importNodes("sub", [a, b], true);
    s.saveChain({ id: randomUUID(), name: "chain", nodeIds: ["a", "b"] });
    s.importNodes("sub", [{ ...a, id: "incoming", name: "Updated" }], true);
    expect(s.all<typeof a>("nodes")[0].id).toBe("a");
    expect(s.all<typeof a>("nodes")[0].name).toBe("Updated");
    expect(s.all("chains")).toHaveLength(0);
  });
  it("嵌套事务失败时整体回滚", () => {
    const s = store();
    expect(() =>
      s.transaction(() => {
        s.saveTag({ id: "m", name: "m", kind: "manual" });
        s.transaction(() => {
          throw new Error("failure");
        });
      }),
    ).toThrow("failure");
    expect(s.all("tags")).toHaveLength(0);
  });
});
