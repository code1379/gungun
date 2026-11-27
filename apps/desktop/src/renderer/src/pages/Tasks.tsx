import { useState } from "react";
import { ChevronDown, XCircle } from "lucide-react";
import { useApp } from "../api";
import { Badge, Button, Empty, ErrorView, PageHeader, Progress } from "../components/ui";

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024, index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

const labels = {
  queued: "排队中",
  running: "执行中",
  cancelling: "正在中断",
  cancelled: "已取消",
  success: "成功",
  failed: "失败",
  interrupted: "应用退出时中断",
};

export default function Tasks() {
  const { data, call, run } = useApp();
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>({});
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="任务中心"
        description="查看执行步骤、错误原因和回滚结果。不同 VPS 的任务可以同时执行。"
      />
      {data.tasks.length ? (
        <div className="tasks-list">
          {[...data.tasks].reverse().map((task) => {
            const cancellable = ["queued", "running", "cancelling"].includes(task.state);
            const expanded = expandedTasks[task.id] ?? false;
            return (
              <section className="task-card" key={task.id}>
                <div className="task-card-layout">
                  <details
                    className="task-card-disclosure"
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setExpandedTasks((current) =>
                        current[task.id] === open
                          ? current
                          : { ...current, [task.id]: open },
                      );
                    }}
                  >
                    <summary className="task-card-summary">
                      <div className="task-summary-main">
                        <div className="task-summary-title">
                          <h2>{task.type}</h2>
                          <p>
                            {data.vps.find((vps) => vps.id === task.vpsId)?.name || "本机任务"}
                            {" · "}
                            {new Date(task.createdAt).toLocaleString()}
                          </p>
                          {task.summary && (
                            <p className="task-summary-description">{task.summary}</p>
                          )}
                        </div>
                        <div className="task-summary-meta">
                          <Badge
                            tone={
                              task.state === "success"
                                ? "good"
                                : ["failed", "interrupted"].includes(task.state)
                                  ? "bad"
                                  : "blue"
                            }
                          >
                            {labels[task.state]}
                          </Badge>
                          <span className="task-expand-label">
                            执行详情
                            <ChevronDown size={15} />
                          </span>
                        </div>
                      </div>
                      {!expanded && ["queued", "running", "cancelling"].includes(task.state) && (
                        <Progress
                          value={task.progress}
                          max={100}
                          aria-label="任务进度"
                        />
                      )}
                    </summary>
                    <div className="task-card-details">
                      {expanded && (
                        <>
                          <div className="task-progress-meta">
                            <span>执行进度</span>
                            <strong>{task.progress}%</strong>
                          </div>
                          <Progress value={task.progress} max={100} aria-label="任务进度" />
                        </>
                      )}
                      <div className="task-steps">
                        {task.steps.map((step, index) => (
                          <div key={index} className={`task-step step-${step.state}`}>
                            <span className="step-dot" />
                            <div>
                              <span>{step.name}</span>
                              {step.transfer && (
                                <div className="task-transfer">
                                  <div className="task-transfer-meta">
                                    <span>
                                      {formatBytes(step.transfer.transferred)} /{" "}
                                      {formatBytes(step.transfer.total)}
                                    </span>
                                    <strong>{step.transfer.percent}%</strong>
                                  </div>
                                  <Progress
                                    value={step.transfer.percent}
                                    max={100}
                                    aria-label="文件传输进度"
                                  />
                                </div>
                              )}
                              {step.message && (
                                <p className={step.state === "fallback" ? "task-step-fallback-message" : "error-text"}>
                                  {step.message}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                      {task.error && <ErrorView error={task.error} />}
                    </div>
                  </details>
                  {cancellable && (
                    <div className="task-card-actions">
                      <Button
                        size="sm"
                        variant={task.state === "queued" ? "secondary" : "danger"}
                        disabled={task.state === "cancelling"}
                        onClick={() => {
                          void run(
                            () => call("cancelTask", { id: task.id }),
                            task.state === "queued" ? "任务已取消" : "已发送中断请求",
                          );
                        }}
                      >
                        <XCircle size={14} />
                        {task.state === "queued"
                          ? "取消任务"
                          : task.state === "cancelling"
                            ? "正在中断…"
                            : "中断任务"}
                      </Button>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty title="所有任务，都在这里">
          部署、同步、测速和证书续期会记录执行步骤。应用退出导致的未完成任务会标记为已中断。
        </Empty>
      )}
    </>
  );
}
