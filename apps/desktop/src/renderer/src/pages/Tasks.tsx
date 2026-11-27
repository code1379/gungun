import { ChevronDown } from "lucide-react";
import { useApp } from "../api";
import { Badge, Empty, ErrorView, PageHeader, Progress } from "../components/ui";

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
  success: "成功",
  failed: "失败",
  interrupted: "已中断",
};

export default function Tasks() {
  const { data } = useApp();
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="任务中心"
        description="查看执行步骤、错误原因和回滚结果。不同 VPS 的任务可以同时执行。"
      />
      {data.tasks.length ? (
        <div className="tasks-list">
          {[...data.tasks].reverse().map((task) => (
            <details className="task-card" key={task.id}>
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
                {task.state === "running" && (
                  <Progress
                    value={task.progress}
                    max={100}
                    aria-label="任务进度"
                  />
                )}
              </summary>
              <div className="task-card-details">
                <div className="task-progress-meta">
                  <span>执行进度</span>
                  <strong>{task.progress}%</strong>
                </div>
                <Progress value={task.progress} max={100} aria-label="任务进度" />
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
                              aria-label="文件上传进度"
                            />
                          </div>
                        )}
                        {step.message && (
                          <p className="error-text">{step.message}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {task.error && <ErrorView error={task.error} />}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <Empty title="所有任务，都在这里">
          部署、同步、测速和证书续期会记录执行步骤。应用退出导致的未完成任务会标记为已中断。
        </Empty>
      )}
    </>
  );
}
