import { useCallback, useEffect, useRef, useState } from "react";
import type { NetworkService } from "../../../main/system-proxy";
import { useApp } from "../api";
import { Select } from "./ui";

export function useNetworkServices() {
  const { call } = useApp();
  const [services, setServices] = useState<NetworkService[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    setServices([]);
    try {
      const list = await call<NetworkService[]>("networkServices");
      if (current !== generation.current) return null;
      setServices(list);
      return list;
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [call]);
  return { services, loading, error, reload };
}
export default function NetworkServicePicker({
  services,
  loading,
  error,
  value,
  onValueChange,
  allowAuto = false,
  id,
  "aria-describedby": description,
}: {
  services: NetworkService[];
  loading: boolean;
  error: string;
  value: string;
  onValueChange: (id: string) => void;
  allowAuto?: boolean;
  id?: string;
  "aria-describedby"?: string;
}) {
  return (
    <div className="grid gap-2">
      <Select
        id={id}
        aria-describedby={description}
        aria-label={allowAuto ? "首选网络服务" : "活动网络服务"}
        value={value}
        onValueChange={onValueChange}
        disabled={loading || !!error || !services.length}
        placeholder={
          loading
            ? "正在读取网络服务…"
            : error
              ? "网络服务读取失败"
              : "请选择网络服务"
        }
      >
        {allowAuto && <option value="">每次开启时选择活动服务</option>}
        {services.map((service) => (
          <option
            key={service.id}
            value={service.id}
            disabled={!allowAuto && !service.active}
          >
            {service.name}
            {service.active ? "（活动）" : ""}
          </option>
        ))}
      </Select>
      {loading && (
        <p role="status" className="hint">
          正在读取本机网络服务…
        </p>
      )}
      {!loading && error && (
        <p role="alert" className="error-text">
          读取网络服务失败：{error}
        </p>
      )}
      {!loading && !error && !services.length && (
        <p role="status" className="hint">
          未发现已启用的网络服务，请检查 macOS 网络设置后刷新。
        </p>
      )}
      {!loading &&
        !error &&
        services.length > 0 &&
        !services.some((service) => service.active) && (
          <p role="status" className="hint">
            已找到网络服务，但尚未识别到活动连接。请连接网络后刷新。
          </p>
        )}
    </div>
  );
}
