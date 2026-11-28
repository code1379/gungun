import { describe, expect, it } from "vitest";
import { MacProxyAdapter } from "../apps/desktop/src/main/system-proxy";
import {
  parseNetworkServices,
  primaryServiceFromState,
  readMacNetworkServices,
  type NetworkReadCommand,
} from "../apps/desktop/src/main/network-services";
const services = {
  "11111111-1111-1111-1111-111111111111": {
    UserDefinedName: "Wi-Fi",
    Proxies: { HTTPEnable: 0 },
  },
  "22222222-2222-2222-2222-222222222222": {
    UserDefinedName: "USB 10/100/1000 LAN",
    Proxies: {
      ProxyAutoConfigEnable: 1,
      ProxyAutoConfigURLString: "https://example.com/proxy.pac",
      ExceptionsList: ["localhost", "*.local"],
    },
  },
  "33333333-3333-3333-3333-333333333333": {
    UserDefinedName: "停用连接",
    __INACTIVE__: 1,
  },
};
const primary = "22222222-2222-2222-2222-222222222222";
describe("macOS 网络服务只读查询", () => {
  it("Wi-Fi / USB LAN、活动标记、完整 PAC 与绕过列表；排除已停用服务", () => {
    const list = parseNetworkServices(JSON.stringify(services), primary);
    expect(list.map((s) => s.name)).toEqual(["USB 10/100/1000 LAN", "Wi-Fi"]);
    expect(list[0].id).toBe(primary);
    expect(list[0].active).toBe(true);
    expect(list[1].active).toBe(false);
    expect(list[0].proxies).toEqual(services[primary].Proxies);
  });
  it("开发模式直接执行只读系统查询，不调用授权助手或 networksetup 写操作", async () => {
    const calls: { file: string; args: string[]; input?: string }[] = [];
    const command: NetworkReadCommand = async (file, args, input) => {
      calls.push({ file, args, input });
      return file.endsWith("plutil")
        ? JSON.stringify(services)
        : `<dictionary> {\n  PrimaryService : ${primary}\n}\n`;
    };
    const adapter = new MacProxyAdapter(undefined, () =>
      readMacNetworkServices(command, "darwin"),
    );
    const list =
      await adapter.request<{ name: string; active: boolean }[]>("services");
    expect(list[0].name).toBe("USB 10/100/1000 LAN");
    expect(list[0].active).toBe(true);
    expect(calls.map((c) => c.file)).toEqual([
      "/usr/bin/plutil",
      "/usr/sbin/scutil",
    ]);
    expect(calls[0].args).toEqual([
      "-extract",
      "NetworkServices",
      "json",
      "-o",
      "-",
      "/Library/Preferences/SystemConfiguration/preferences.plist",
    ]);
    expect(calls[1].input).toBe("show State:/Network/Global/IPv4\nquit\n");
    // All other operations still go through the authorization boundary.
    await expect(
      adapter.request("enable", { serviceId: primary, port: 10808 }),
    ).rejects.toThrow();
  });
  it("IPv4 没有活动服务时读取 IPv6，不把第一个网络服务猜作活动", async () => {
    const inputCalls: string[] = [];
    const command: NetworkReadCommand = async (file, _args, input) => {
      if (file.endsWith("plutil")) return JSON.stringify(services);
      inputCalls.push(input || "");
      return input?.includes("IPv6")
        ? `<dictionary> {\n PrimaryService : ${primary}\n}`
        : "No such key\n";
    };
    const list = await readMacNetworkServices(command, "darwin");
    expect(list[0].active).toBe(true);
    expect(inputCalls).toHaveLength(2);
    expect(
      parseNetworkServices(JSON.stringify(services), null).every(
        (s) => !s.active,
      ),
    ).toBe(true);
  });
  it("空配置与损坏 / 不可读配置明确区分", async () => {
    expect(parseNetworkServices("{}", null)).toEqual([]);
    expect(() =>
      parseNetworkServices("bad JSON containing private details", null),
    ).toThrow("无法解析");
    expect(() =>
      parseNetworkServices('{"service":{"Proxies":null}}', null),
    ).toThrow("结构无法识别");
    await expect(
      readMacNetworkServices(async () => {
        throw new Error("读取被拒绝");
      }, "darwin"),
    ).rejects.toThrow("读取被拒绝");
  });
  it("没有友好名称时回退到实际接口，PAC 不可读仍允许只读查看", () => {
    const list = parseNetworkServices(
      JSON.stringify({
        id: {
          Interface: { DeviceName: "en7" },
          Proxies: { ProxyAutoConfigEnable: 1 },
        },
      }),
      null,
    );
    expect(list[0].name).toBe("en7");
    expect(list[0].proxies).toEqual({ ProxyAutoConfigEnable: 1 });
    expect(primaryServiceFromState("PrimaryService : bad/value")).toBe(null);
  });
  it("非 macOS 明确拒绝查询，且不尝试执行系统命令", async () => {
    let called = false;
    await expect(
      readMacNetworkServices(async () => {
        called = true;
        return "{}";
      }, "linux"),
    ).rejects.toThrow("仅支持 macOS");
    expect(called).toBe(false);
  });
});
