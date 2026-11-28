import { useState } from "react";
import {
  Cloud,
  LayoutDashboard,
  Server,
  Rocket,
  Network as NetworkIcon,
  Layers,
  ListTodo,
  Settings as SettingsIcon,
  CircleHelp,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useApp } from "./api";
import { Feedback, Button } from "./components/ui";
import Dashboard from "./pages/Dashboard";
import Vps from "./pages/Vps";
import Deploy from "./pages/Deploy";
import Network from "./pages/Network";
import Nodes from "./pages/Nodes";
import Tasks from "./pages/Tasks";
import Settings from "./pages/Settings";
import Help from "./pages/Help";
import WorkWindow from "./pages/WorkWindow";
import Cloudflare from "./pages/Cloudflare";
import ProxyBar from "./components/ProxyBar";
const navigation = [
  { id: "dashboard", label: "主控制台", icon: LayoutDashboard },
  { id: "vps", label: "VPS 管理", icon: Server },
  { id: "deploy", label: "部署中心", icon: Rocket },
  { id: "cloudflare", label: "Cloudflare", icon: Cloud },
  { id: "network", label: "网络服务", icon: NetworkIcon },
  { id: "nodes", label: "节点与订阅", icon: Layers },
  { id: "tasks", label: "任务中心", icon: ListTodo },
  { id: "settings", label: "设置", icon: SettingsIcon },
  { id: "help", label: "帮助与文档", icon: CircleHelp },
];
export default function App() {
  const [page, setPage] = useState("dashboard");
  const [collapsed, setCollapsed] = useState(false);
  const { data } = useApp();
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (view && view !== "main")
    return (
      <>
        <WorkWindow type={view} id={params.get("id") || ""} />
        <Feedback />
      </>
    );
  const running =
    data?.tasks.filter((t) => ["queued", "running"].includes(t.state)).length ||
    0;
  return (
    <div
      className={`shell grid h-screen grid-rows-[minmax(0,1fr)] overflow-hidden text-foreground ${collapsed ? "collapsed grid-cols-[72px_1fr]" : "grid-cols-[220px_1fr]"}`}
    >
      <aside className="sidebar flex min-h-0 w-full flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground">
        <div className="window-drag" />
        <div className="brand">
          <div className="brand-symbol">g</div>
          {!collapsed && (
            <div>
              <strong>Gungun</strong>
              <small>本地网络工作台</small>
            </div>
          )}
        </div>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <Button
              variant="ghost"
              key={item.id}
              title={collapsed ? item.label : undefined}
              className={`nav-item justify-start ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={18} />
              {!collapsed && <span>{item.label}</span>}
              {item.id === "tasks" && running > 0 && (
                <small className="nav-count">{running}</small>
              )}
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {!collapsed && (
            <div className="local-status">
              <span className="status-dot" />
              <span>本机工作区</span>
              <small>{data ? "已就绪" : "载入中"}</small>
            </div>
          )}
          <Button
            variant="ghost"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开菜单" : "折叠菜单"}
          >
            {collapsed ? (
              <PanelLeftOpen size={17} />
            ) : (
              <PanelLeftClose size={17} />
            )}
          </Button>
        </div>
      </aside>
      <main className="workspace flex min-h-0 min-w-0 flex-col bg-background">
        <div className="topbar window-drag">
          <span>{navigation.find((n) => n.id === page)?.label}</span>
          <span className="grow" />
          <span className="topbar-status">
            {running ? `${running} 个任务进行中` : "本地管理 · SSH 同步"}
          </span>
        </div>
        <div className="page-content flex-1 overflow-auto px-7 py-7">
          {page === "dashboard" && <Dashboard navigate={setPage} />}
          {page === "vps" && <Vps />}
          <div hidden={page !== "deploy"}><Deploy /></div>
          {page === "cloudflare" && <Cloudflare />}
          {page === "network" && <Network />}
          {page === "nodes" && <Nodes />}
          {page === "tasks" && <Tasks />}
          {page === "settings" && <Settings />}
          {page === "help" && <Help />}
        </div>
        <ProxyBar openSettings={() => setPage("settings")} />
      </main>
      <Feedback />
    </div>
  );
}
