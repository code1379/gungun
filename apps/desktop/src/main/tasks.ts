import type { Task } from "@gungun/domain";
import type { Store } from "./store";

export class StepFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepFallbackError";
  }
}

interface PendingTask {
  task: Task;
  run: TaskRun;
  controller: AbortController;
}

type TaskRun = (step: Step, signal: AbortSignal) => Promise<unknown>;

function abortError() {
  const error = new Error("任务已取消");
  error.name = "AbortError";
  return error;
}

export class TaskCenter {
  private pending: PendingTask[] = [];
  private active = 0;
  private locks = new Set<string>();
  private controllers = new Map<string, AbortController>();

  constructor(
    private store: Store,
    private notify: () => void,
    private limit = 4,
  ) {}

  submit(type: string, vpsId: string | null, run: TaskRun, summary?: string) {
    const task = this.store.task(type, vpsId, summary);
    this.pending.push({ task, run, controller: new AbortController() });
    this.notify();
    this.pump();
    return task.id;
  }

  cancel(id: string) {
    const queuedIndex = this.pending.findIndex((item) => item.task.id === id);
    if (queuedIndex >= 0) {
      const [item] = this.pending.splice(queuedIndex, 1);
      item.task.state = "cancelled";
      item.task.error = null;
      this.save(item.task);
      return true;
    }

    const task = this.store.get<Task>("tasks", id);
    const controller = this.controllers.get(id);
    if (!controller || ["success", "failed", "cancelled", "interrupted"].includes(task.state))
      return false;
    if (task.state !== "cancelling") {
      task.state = "cancelling";
      this.save(task);
      controller.abort(abortError());
    }
    return true;
  }

  private pump() {
    while (this.active < this.limit) {
      const index = this.pending.findIndex(
        (item) => !item.task.vpsId || !this.locks.has(item.task.vpsId),
      );
      if (index < 0) return;
      const item = this.pending.splice(index, 1)[0];
      if (item.controller.signal.aborted) {
        item.task.state = "cancelled";
        this.save(item.task);
        continue;
      }
      this.active++;
      if (item.task.vpsId) this.locks.add(item.task.vpsId);
      this.controllers.set(item.task.id, item.controller);
      void this.execute(item).finally(() => {
        this.controllers.delete(item.task.id);
        this.active--;
        if (item.task.vpsId) this.locks.delete(item.task.vpsId);
        this.pump();
      });
    }
  }

  private async execute(item: PendingTask) {
    const { task, run, controller } = item;
    const signal = controller.signal;
    task.state = "running";
    this.save(task);

    const step: Step = async (name, fn) => {
      if (signal.aborted) throw abortError();
      task.steps.push({ name, state: "running", at: new Date().toISOString() });
      const index = task.steps.length - 1;
      this.save(task);
      const reportTransfer: TransferReporter = (transferred, total) => {
        if (!Number.isFinite(transferred) || !Number.isFinite(total) || total <= 0) return;
        const safeTotal = Math.max(1, Math.floor(total));
        const safeTransferred = Math.min(safeTotal, Math.max(0, Math.floor(transferred)));
        const percent = Math.round((safeTransferred / safeTotal) * 100);
        task.steps[index].transfer = { transferred: safeTransferred, total: safeTotal, percent };
        task.progress = Math.max(task.progress, Math.min(75, 15 + Math.round(percent * 0.45)));
        this.save(task);
      };
      try {
        const result = await fn(reportTransfer, signal);
        if (signal.aborted) throw abortError();
        task.steps[index].state = "success";
        task.steps[index].transfer = task.steps[index].transfer
          ? { ...task.steps[index].transfer, percent: 100, transferred: task.steps[index].transfer.total }
          : undefined;
        task.progress = Math.min(95, Math.max(task.progress, task.progress + 15));
        this.save(task);
        return result;
      } catch (error) {
        if (error instanceof StepFallbackError && !signal.aborted) {
          task.steps[index].state = "fallback";
          task.steps[index].message = error.message;
          this.save(task);
          return undefined;
        }
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          task.steps[index].state = "cancelled";
          task.steps[index].message = "已按用户请求中断";
        } else {
          task.steps[index].state = "failed";
          task.steps[index].message = redact(String(error));
        }
        this.save(task);
        throw error;
      }
    };

    try {
      const output = await run(step, signal);
      if (signal.aborted) throw abortError();
      if (output !== undefined) task.output = output;
      task.state = "success";
      task.progress = 100;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        task.state = "cancelled";
        task.error = null;
      } else {
        task.state = "failed";
        task.error = redact(String(error));
      }
    }
    this.save(task);
  }

  report(id: string, completed: number, total: number, output?: unknown) {
    const task = this.store.get<Task>("tasks", id);
    this.store.putRaw("tasks", {
      ...task,
      progress: Math.max(task.progress, Math.min(95, Math.round(completed / Math.max(1, total) * 95))),
      output: output ?? task.output,
      updatedAt: new Date().toISOString(),
    });
    this.notify();
  }

  private save(task: Task) {
    task.updatedAt = new Date().toISOString();
    const latest = this.store.get<Task>("tasks", task.id);
    this.store.putRaw("tasks", {
      ...task,
      progress: Math.max(task.progress, latest.progress),
      output: task.output ?? latest.output,
    });
    this.notify();
  }
}

export type TransferReporter = (transferred: number, total: number) => void;
export type Step = <T>(
  name: string,
  fn: (reportTransfer: TransferReporter, signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export function redact(value: string) {
  return value
    .replace(
      /(password|token|key|secret|X-Auth-Key)(["'\s:=]+)[^\s,"'}]+/gi,
      "$1$2[redacted]",
    )
    .slice(-12000);
}

export async function pooled<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await run(item);
      }
    }),
  );
}

export class ConcurrencyGate {
  private active = 0;
  private queue: {
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (e: unknown) => void;
  }[] = [];
  constructor(private limit: () => number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: fn,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.pump();
    });
  }
  private pump() {
    while (this.active < this.limit() && this.queue.length) {
      const item = this.queue.shift()!;
      this.active++;
      void item
        .run()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
