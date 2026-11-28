import { ArrowUpRight, Server, Layers, Workflow, Activity } from "lucide-react";
import { useApp } from "../api";
import { Badge, Button, Empty, PageHeader } from "../components/ui";
export default function Dashboard({
  navigate,
}: {
  navigate: (page: string) => void;
}) {
  const { data, call, run } = useApp();
  if (!data) return null;
  const running = data.tasks.filter(
    (t) => t.state === "running" || t.state === "queued",
  );
  return (
    <>
      <PageHeader
        title="主控制台"
        description="从这台 Mac，管理你的网络。"
        actions={
          <Button variant="default" onClick={() => navigate("vps")}>
            添加 VPS <ArrowUpRight size={16} />
          </Button>
        }
      />
      <div className="metrics">
        {[
          { label: "VPS", value: data.vps.length, icon: Server },
          { label: "节点", value: data.nodes.length, icon: Layers },
          { label: "代理链", value: data.chains.length, icon: Workflow },
          { label: "执行中任务", value: running.length, icon: Activity },
        ].map((item) => (
          <div className="metric" key={item.label}>
            <item.icon size={18} />
            <strong>{item.value}</strong>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      {!data.vps.length ? (
        <Empty
          title="连接第一台 VPS"
          action={
            <Button onClick={() => navigate("vps")}>前往 VPS 管理</Button>
          }
        >
          添加公网或 NAT 主机，测试 SSH 连接，再安装 fq。节点通过 SSH
          手动同步到本机。
        </Empty>
      ) : (
        <section className="section">
          <div className="section-heading">
            <h2>你的主机</h2>
            <Button variant="ghost" onClick={() => navigate("vps")}>
              管理主机 <ArrowUpRight size={15} />
            </Button>
          </div>
          <div className="host-list">
            {data.vps.map((v) => (
              <div key={v.id} className="host-row">
                <div className="host-symbol">
                  <Server size={21} />
                </div>
                <div className="grow">
                  <strong>{v.name}</strong>
                  <p>
                    {v.address}:{v.sshPort}
                  </p>
                </div>
                <Badge>{v.kind === "nat" ? "NAT VPS" : "公网 VPS"}</Badge>
                <span className="muted">
                  {data.nodes.filter((n) => n.vpsId === v.id).length} 节点
                </span>
                <Button
                  onClick={() => {
                    void run(() => call("syncVps", v.id), "同步任务已加入队列");
                  }}
                >
                  同步节点
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="section">
        <div className="section-heading">
          <h2>最近任务</h2>
          <Button variant="ghost" onClick={() => navigate("tasks")}>
            查看全部 <ArrowUpRight size={15} />
          </Button>
        </div>
        {data.tasks.length ? (
          <div>
            {data.tasks
              .slice(-5)
              .reverse()
              .map((t) => (
                <button
                  className="task-row"
                  key={t.id}
                  onClick={() => {
                    void run(() =>
                      call("openWindow", { type: "task", id: t.id }),
                    );
                  }}
                >
                  <span>{t.type}</span>
                  <span className="muted grow">
                    {data.vps.find((v) => v.id === t.vpsId)?.name || "Mac 本机"}
                  </span>
                  <Badge
                    tone={
                      t.state === "success"
                        ? "good"
                        : t.state === "failed"
                          ? "bad"
                          : "neutral"
                    }
                  >
                    {
                      {
                        success: "成功",
                        failed: "失败",
                        running: "执行中",
                        queued: "排队中",
                        cancelled: "已取消",
                        cancelling: "取消中",
                        interrupted: "已中断",
                      }[t.state]
                    }
                  </Badge>
                </button>
              ))}
          </div>
        ) : (
          <p className="quiet">任务的执行步骤、错误和回滚结果会显示在这里。</p>
        )}
      </section>
    </>
  );
}
