import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { NetworkService } from "./system-proxy";
const exec = promisify(execFile);
export type NetworkReadCommand = (
  file: string,
  args: string[],
  input?: string,
) => Promise<string>;
const serviceSchema = z
  .object({
    UserDefinedName: z.string().optional(),
    __INACTIVE__: z.union([z.number(), z.boolean()]).optional(),
    Interface: z
      .object({ DeviceName: z.string().optional() })
      .passthrough()
      .optional(),
    Proxies: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// These commands only read configuration; authorization and all mutations remain
// in the signed XPC helper. Never use these snapshots to confirm a write/restore.
const readCommand: NetworkReadCommand = async (file, args, input) => {
  const result = exec(file, args, {
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
  result.child.stdin?.on("error", () => {});
  result.child.stdin?.end(input);
  try {
    return (await result).stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // execFile errors may include stdout with private network configuration.
    throw new Error(
      `macOS 只读网络查询失败${code ? `（${code}）` : ""}，请检查系统网络配置的读取权限`,
      { cause: error },
    );
  }
};
export function primaryServiceFromState(output: string): string | null {
  const line = output.match(/^\s*PrimaryService\s*:\s*([A-Za-z0-9-]+)\s*$/m);
  return line?.[1] || null;
}
export function parseNetworkServices(
  raw: string,
  primary: string | null,
): NetworkService[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("macOS 网络服务配置无法解析，未将读取失败当作空列表");
  }
  const parsed = z.record(z.string().min(1), serviceSchema).safeParse(json);
  if (!parsed.success)
    throw new Error("macOS 网络服务配置结构无法识别，请检查网络设置后重试");
  return Object.entries(parsed.data)
    .filter(([, service]) => !service.__INACTIVE__)
    .map(([id, service]) => ({
      id,
      name: service.UserDefinedName || service.Interface?.DeviceName || id,
      active: primary === id,
      proxies: service.Proxies || {},
    }))
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
    );
}
export async function readMacNetworkServices(
  command: NetworkReadCommand = readCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<NetworkService[]> {
  if (platform !== "darwin") throw new Error("本机网络服务查询仅支持 macOS");
  const raw = await command("/usr/bin/plutil", [
    "-extract",
    "NetworkServices",
    "json",
    "-o",
    "-",
    "/Library/Preferences/SystemConfiguration/preferences.plist",
  ]);
  const ipv4 = await command(
    "/usr/sbin/scutil",
    [],
    "show State:/Network/Global/IPv4\nquit\n",
  );
  let primary = primaryServiceFromState(ipv4);
  if (!primary) {
    const ipv6 = await command(
      "/usr/sbin/scutil",
      [],
      "show State:/Network/Global/IPv6\nquit\n",
    );
    primary = primaryServiceFromState(ipv6);
  }
  return parseNetworkServices(raw, primary);
}
