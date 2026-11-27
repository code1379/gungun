import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/desktop/src/main/store";
import { TaskCenter, ConcurrencyGate } from "../apps/desktop/src/main/tasks";
import type { Task } from "../packages/domain/src/index";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
it("并行任务共用全局并发上限，失败也释放槽位", async () => {
  let active = 0,
    maximum = 0;
  const gate = new ConcurrencyGate(() => 3);
  await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      gate.run(async () => {
        active++;
        maximum = Math.max(active, maximum);
        try {
          await new Promise((r) => setTimeout(r, 3));
          if (i === 2) throw new Error("failed test");
        } finally {
          active--;
        }
      }),
    ),
  );
  expect(maximum).toBe(3);
  expect(active).toBe(0);
});
it("同 VPS 串行，不同 VPS 并行，并持久化实际任务输出", async () => {
  const path = mkdtempSync(join(tmpdir(), "gungun-tasks-"));
  const store = new Store(join(path, "db"));
  const first = deferred(),
    other = deferred(),
    secondStarted = deferred();
  const events: string[] = [];
  const center = new TaskCenter(store, () => {}, 4);
  try {
    const firstTask = center.submit("a1", "a", async (step) =>
      step("wait", async () => {
        events.push("a1");
        await first.promise;
        return { verified: true };
      }),
    );
    const second = center.submit("a2", "a", async () => {
      events.push("a2");
      secondStarted.resolve();
    });
    center.submit("b1", "b", async () => {
      events.push("b1");
      other.resolve();
    });
    await other.promise;
    expect(events).toEqual(["a1", "b1"]);
    center.report(firstTask, 5, 10);
    expect(store.get<Task>("tasks", firstTask).progress).toBeGreaterThan(0);
    first.resolve();
    await secondStarted.promise;
    await new Promise((r) => setTimeout(r, 10));
    expect(store.get<Task>("tasks", second).state).toBe("success");
    expect(
      store.all<Task>("tasks").find((t) => t.type === "a1")?.output,
    ).toEqual({ verified: true });
  } finally {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("任务步骤持续保存文件传输百分比和字节数", async () => {
  const path = mkdtempSync(join(tmpdir(), "gungun-transfer-"));
  const store = new Store(join(path, "db"));
  const center = new TaskCenter(store, () => {}, 2);
  const waiting = deferred();
  const release = deferred();
  try {
    const id = center.submit("upload", "vps-upload", async (step) =>
      step("上传 fq", async (reportTransfer) => {
        reportTransfer(512, 1024);
        waiting.resolve();
        await release.promise;
      }),
    );
    await waiting.promise;
    const task = store.get<Task>("tasks", id);
    expect(task.steps[0].transfer).toEqual({
      transferred: 512,
      total: 1024,
      percent: 50,
    });
    expect(task.progress).toBeGreaterThan(0);
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.get<Task>("tasks", id).steps[0].transfer?.percent).toBe(100);
  } finally {
    release.resolve();
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
