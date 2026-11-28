import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  serviceSchema,
  matchesDNSName,
  websiteSchema,
  type ProxyNode,
  type Chain,
  type RemoteState,
  type Service,
  type VPS,
  type Website,
} from "@gungun/domain";
import { Cloudflare, withCloudflareMutation, compensate } from "./cloudflare";
import { Certificates } from "./certificates";
import type { Store } from "./store";
import type { SSH } from "./ssh";
import { StepFallbackError, type Step } from "./tasks";
import { shellQuote } from "./ssh";
const _protocolDomainPrefix: Record<Service["protocol"], string> = {
  hysteria2: "hy2",
  tuic: "tuic",
  anytls: "anytls",
  snell: "snell",
  "vless-ws": "vless-ws",
  "vless-reality": "reality",
};

function tunnelIngress(state: Pick<RemoteState, "services" | "websites" | "camouflage">) {
  return [
    ...state.services
      .filter((service) => service.access === "argo")
      .map((service) => ({
        hostname: service.domain,
        service:
          service.protocol === "vless-ws"
            ? `https://127.0.0.1:${service.port}`
            : `http://127.0.0.1:${service.port}`,
        ...(service.protocol === "vless-ws"
          ? { originRequest: { originServerName: service.domain } }
          : {}),
      })),
    ...state.websites
      .filter((website) => website.access === "argo")
      .map((website) => ({
        hostname: website.domain,
        service: `http://127.0.0.1:${website.port}`,
      })),
    ...(state.camouflage ? [{ hostname: state.camouflage.domain, service: `http://127.0.0.1:${state.camouflage.port}` }] : []),
  ];
}

export function tunnelIngressSignature(
  state: Pick<RemoteState, "services" | "websites" | "camouflage">,
) {
  return JSON.stringify(
    tunnelIngress(state).sort((a, b) =>
      (a.hostname || "").localeCompare(b.hostname || ""),
    ),
  );
}
export class Orchestrator {
  readonly certificates: Certificates;

  constructor(
    private store: Store,
    private ssh: SSH,
    private resources: string,
    private notify: () => void,
    certDir: string,
  ) {
    this.certificates = new Certificates(store, ssh, certDir);
  }
  private async ensureFqCurrent(vps: VPS, step: Step) {
    const arch = (await this.ssh.run(vps, "uname -m")).trim();
    const target = arch === "x86_64" ? "amd64" : ["aarch64", "arm64"].includes(arch) ? "arm64" : null;
    if (!target) throw new Error(`不支持的 CPU：${arch}`);
    const local = join(this.resources, `fq-linux-${target}`);
    const binary = await readFile(local);
    const digest = createHash("sha256").update(binary).digest("hex");
    let current = "";
    try {
      current = (await this.ssh.run(vps, "sha256sum /usr/local/bin/fq 2>/dev/null | awk '{print $1}'")).trim();
    } catch { /* Missing fq is handled by the caller's normal install flow. */ }
    if (current === digest) return;
    const remote = `/tmp/gungun-fq-update-${randomUUID()}`;
    const staged = `/usr/local/bin/.fq-update-${randomUUID()}`;
    try {
      await step("上传新版 fq 管理器", (report) => this.ssh.upload(vps, local, remote, report));
      await step("原子更新 fq 管理器", () => this.ssh.run(
        vps,
        `${vps.username === "root" ? "" : "sudo -n "}install -m 0755 ${shellQuote(remote)} ${shellQuote(staged)} && ${vps.username === "root" ? "" : "sudo -n "}mv -f ${shellQuote(staged)} /usr/local/bin/fq && rm -f ${shellQuote(remote)}`,
      ));
    } finally {
      await this.ssh.run(vps, `rm -f ${shellQuote(remote)} ${shellQuote(staged)}`).catch(() => {});
    }
  }

  async install(vps: VPS, step: Step, signal: AbortSignal) {
    await step("连接 VPS 并识别 CPU", (_report, stepSignal) => this.ssh.test(vps).then((result) => {
      if (stepSignal.aborted) throw Object.assign(new Error("任务已取消"), { name: "AbortError" });
      return result;
    }));
    const arch = (await this.ssh.run(vps, "uname -m")).trim();
    const target =
      arch === "x86_64"
        ? "amd64"
        : ["aarch64", "arm64"].includes(arch)
          ? "arm64"
          : null;
    if (!target) throw new Error(`不支持的 CPU：${arch}`);
    const local = join(this.resources, `fq-linux-${target}`);
    const remote = `/tmp/gungun-fq-${randomUUID()}`;
    const staged = `/usr/local/bin/.fq-${randomUUID()}.new`;
    const settings = this.store.settings();
    const mode = settings.fqDownloadMode || "auto";
    let installed = false;
    try {
      const binary = await readFile(local);
      const digest = createHash("sha256").update(binary).digest("hex");
      let releaseVersion = "dev";
      try {
        const output = execFileSync(local, ["version"], { encoding: "utf8", timeout: 5000 });
        releaseVersion = String(JSON.parse(output).version || "dev");
      } catch { /* Development build: use SFTP. */ }
      const canUseRelease = releaseVersion !== "dev" && /^v?\d+\.\d+\.\d+/.test(releaseVersion);
      if (mode !== "sftp" && canUseRelease) {
        const tag = releaseVersion.startsWith("v") ? releaseVersion : `v${releaseVersion}`;
        const asset = `fq-linux-${target}`;
        const url = `https://github.com/code1379/gungun/releases/download/${tag}/${asset}`;
        const speedLimit = Math.max(16, settings.fqDownloadMinSpeedKBps || 128) * 1024;
        const speedTime = Math.max(5, settings.fqDownloadSlowSeconds || 15);
        const command = [
          "set -eu",
          `tmp=${shellQuote(remote)}`,
          "trap 'rm -f \"$tmp\"' EXIT",
          `curl --fail --location --silent --show-error --speed-limit ${speedLimit} --speed-time ${speedTime} ${shellQuote(url)} -o "$tmp"`,
          `echo ${shellQuote(digest + "  ")}"$tmp" | sha256sum -c -`,
          "chmod 700 \"$tmp\"",
          `${vps.username === "root" ? "" : "sudo -n "}install -m 0755 "$tmp" ${shellQuote(staged)}`,
          `${vps.username === "root" ? "" : "sudo -n "}mv -f ${shellQuote(staged)} /usr/local/bin/fq`,
          "rm -f \"$tmp\"",
          "trap - EXIT",
        ].join(" && ");
        try {
          await step("VPS 直接下载 GitHub Release", async (_report, stepSignal) => {
            if (stepSignal.aborted) throw Object.assign(new Error("任务已取消"), { name: "AbortError" });
            await this.ssh.run(vps, command, "", 10 * 60 * 1000, 16 * 1024 * 1024, stepSignal);
          });
          installed = true;
        } catch (error) {
          if (signal.aborted || mode === "release") throw error;
          await step("Release 下载失败或速度过慢，切换 SFTP", async () => {
            throw new StepFallbackError(`切换到本机 SFTP：${String(error)}`);
          });
        }
      } else if (mode === "release") {
        throw new Error("当前是开发构建，没有对应的正式 GitHub Release 版本；请切换为自动或 SFTP");
      }

      if (!installed) {
        await step("本机 SFTP 上传 fq", (reportTransfer, stepSignal) =>
          this.ssh.upload(vps, local, remote, reportTransfer, stepSignal),
        );
        await step("校验并原子安装 fq", async (_report, stepSignal) => {
          if (stepSignal.aborted) throw Object.assign(new Error("任务已取消"), { name: "AbortError" });
          const sudo = vps.username === "root" ? "" : "sudo -n ";
          await this.ssh.run(
            vps,
            `${sudo}install -m 0755 ${shellQuote(remote)} ${shellQuote(staged)} && ${sudo}mv -f ${shellQuote(staged)} /usr/local/bin/fq && rm -f ${shellQuote(remote)}`,
          );
        });
      }
      await step("安装 fq 服务单元", () => this.ssh.fq(vps, "install"));
      await step("安装并校验 sing-box", () =>
        this.ssh.fq(vps, "core update sing-box", undefined, 10 * 60 * 1000),
      );
    } finally {
      // Best-effort cleanup after cancellation, failed transfer, or install.
      await this.ssh.run(
        vps,
        `rm -f ${shellQuote(remote)} ${shellQuote(staged)}`,
        "",
        15000,
      ).catch(() => {});
    }
  }
  async sync(vps: VPS, step: Step) {
    const data = await step("SSH 读取 fq export", () =>
      this.ssh.fq<{
        schemaVersion: number;
        hostId: string;
        nodes: ProxyNode[];
      }>(vps, "export"),
    );
    if (data.schemaVersion !== 1 || data.hostId !== vps.id)
      throw new Error(
        "fq 导出版本或 VPS ID 不匹配，请先通过部署中心初始化此主机",
      );
    const incoming = new Set(data.nodes.map((n) => n.id));
    const removedIds = new Set(
      this.store
        .all<ProxyNode>("nodes")
        .filter((n) => n.vpsId === vps.id && !incoming.has(n.id))
        .map((n) => n.id),
    );
    const removedChains = this.store
      .all<Chain>("chains")
      .filter((c) => c.nodeIds.some((id) => removedIds.has(id)))
      .map((c) => c.name);
    const count = this.store.sync(vps.id, data.nodes);
    this.notify();
    return { count, removedChains };
  }
  async deploy(
    vps: VPS,
    services: Service[] | undefined,
    website: Website | undefined,
    step: Step,
    signal?: AbortSignal,
  ) {
    const action = async () => {
      if (signal?.aborted) throw Object.assign(new Error("任务已取消"), { name: "AbortError" });
      if (website) return this.deployInner(vps, undefined, website, step);
      if (!services?.length) throw new Error("请选择至少一个协议和接入方式");
      return this.deployServices(vps, services, step, signal);
    };
    return withCloudflareMutation(action);
  }

  /**
   * 一次批量部署作为一个事务处理：
   * 共享远程读取、备份、证书申请、Tunnel 配置、最终 apply 和同步。
   * 任一前置步骤失败立即停止，不再把同一个错误重复执行到后续服务。
   */
  private async deployServices(
    originalVps: VPS,
    input: Service[],
    step: Step,
    _signal?: AbortSignal,
  ) {
    const services = input.map((service) => serviceSchema.parse(service));
    const selected = new Set<string>();
    for (const service of services) {
      const key = `${service.protocol}:${service.access}`;
      if (selected.has(key)) throw new Error(`批量部署包含重复服务：${key}`);
      selected.add(key);
    }

    const credentials = new Map<string, { password: string; uuid: string }>();
    for (const service of services) {
      const shared = credentials.get(service.protocol) || {
        password: service.password || randomUUID() + randomUUID(),
        uuid: service.uuid || randomUUID(),
      };
      service.password ||= shared.password;
      service.uuid ||= shared.uuid;
      credentials.set(service.protocol, shared);
    }

    const undo: (() => Promise<void>)[] = [];
    let vps = originalVps;
    try {
      await this.ensureFqCurrent(originalVps, step);
      let state = await step("读取远程真实配置", () =>
        this.ssh.state(originalVps),
      );
      state = {
        ...state,
        schemaVersion: 1,
        hostId: originalVps.id,
        hostName: originalVps.name,
        kind: originalVps.kind,
        publicAddress: originalVps.publicAddress,
        namespace: originalVps.namespace,
        zoneName: originalVps.zoneName,
      };
      // Only reconcile the Tunnel when this deployment actually changes its Argo ingress.
      const previousTunnelHosts = tunnelIngress(state).flatMap((r) => r.hostname ? [r.hostname] : []);
      const previousTunnelSignature = tunnelIngressSignature(state);

      const backup = await step("备份远程配置", () =>
        this.ssh.fq<{ backupId: string }>(originalVps, "backup"),
      );
      undo.push(async () => {
        await this.ssh.run(
          originalVps,
          `${originalVps.username === "root" ? "" : "sudo -n "}/usr/local/bin/fq restore ${shellQuote(backup.backupId)} --json`,
        );
      });

      // 首次初始化必须先写入 fq 主机标识，后续 CSR 和 apply 才有稳定状态文件。
      if (!state.hostId || (!state.services.length && !state.websites.length && !state.camouflage)) {
        await step("初始化 fq 主机标识", () =>
          this.ssh.fq(originalVps, "apply", state),
        );
      }

      const needsZone = services.some(
        (service) =>
          service.access !== "direct" ||
          !!service.domain ||
          !["snell", "vless-reality"].includes(service.protocol),
      );
      if (needsZone && (!vps.zoneId || !vps.zoneName))
        throw new Error("所选服务需要 Cloudflare Zone，请先绑定域名区域");

      const cf = new Cloudflare(this.store.settings(), undefined, (account, tunnel, hosts) => this.store.saveLocal(`tunnelRoutes:${account}:${tunnel}`, hosts));
      const prefix: Record<Service["protocol"], string> = {
        hysteria2: "hy2",
        tuic: "tuic",
        anytls: "anytls",
        snell: "snell",
        "vless-ws": "vless-ws",
        "vless-reality": "reality",
      };

      // 先统一确定所有入口域名，并按 Free Universal SSL 的覆盖范围回退自动域名。
      for (const service of services) {
        const generatedDomain =
          vps.zoneName && !["snell", "vless-reality"].includes(service.protocol)
            ? `${prefix[service.protocol]}-${service.access}.${vps.namespace}.${vps.zoneName}`
            : "";
        const generated = !service.domain || (!!generatedDomain && service.domain === generatedDomain);
        if (!service.domain && generatedDomain) service.domain = generatedDomain;

        if (service.access !== "direct") {
          if (!vps.zoneId || !vps.zoneName)
            throw new Error("Cloudflare CDN / Argo 需要先绑定 Zone");
          if (!(service.access === "cdn" && service.edgeScheme === "http")) {
            const fallback = generated
              ? `${service.access}-${vps.namespace}.${vps.zoneName}`
              : undefined;
            service.domain = await step(
              "检查 Cloudflare Universal SSL 覆盖",
              () => cf.edgeHostname(vps.zoneId, service.domain, fallback),
            );
          }
        }
      }

      // 所有协议共用一张源站证书；只把通配符无法覆盖的入口加入额外 SAN。
      const certificateHosts = services
        .filter(
          (service) =>
            service.protocol === "vless-ws" ||
            (!["snell", "vless-reality"].includes(service.protocol) &&
              service.access !== "argo"),
        )
        .map((service) => service.domain)
        .filter(Boolean);
      if (certificateHosts.length) {
        if (!vps.zoneId || !vps.zoneName)
          throw new Error("申请源站证书前请先绑定 Cloudflare Zone");
        const expiresAt = Date.parse(state.certificate?.notAfter || "");
        const needsCertificate =
          !state.certificate ||
          !Number.isFinite(expiresAt) ||
          expiresAt < Date.now() + 30 * 86400000 ||
          certificateHosts.some(
            (host) =>
              !state.certificate?.domains?.some((pattern) =>
                matchesDNSName(pattern, host),
              ),
          );
        if (needsCertificate) {
          const issued = await step("DNS-01 申请 / 更新源站证书", () =>
            this.certificates.issue(vps, certificateHosts, state),
          );
          state.certificate = issued.certificate;
        }
      }

      // 把本次所有服务先合并进同一份远程状态，再统一配置 DNS / Tunnel。
      for (const service of services) {
        if (service.protocol === "vless-ws") {
          const shared = state.services.find(
            (item) => item.protocol === "vless-ws",
          );
          service.port =
            service.port ||
            shared?.port ||
            (await this.allocatePort(state, vps));
          const sharedPublic = state.services.find(
            (item) =>
              item.protocol === "vless-ws" && item.access !== "argo",
          )?.publicPort;
          service.publicPort =
            service.access === "argo"
              ? 0
              : service.publicPort || sharedPublic || service.port;
          for (const previous of state.services.filter(
            (item) =>
              item.protocol === "vless-ws" &&
              item.access !== "argo" &&
              service.access !== "argo",
          )) {
            if (previous.publicPort !== service.publicPort)
              throw new Error(
                "VLESS + WS 的直连与 CDN 必须共用一个公网映射端口",
              );
          }
        } else {
          if (!service.port) {
            if (vps.kind === "nat")
              throw new Error("NAT VPS 必须填写内部监听端口");
            service.port = await this.allocatePort(state, vps);
          }
          if (!service.publicPort) {
            if (vps.kind === "nat" && service.access !== "argo")
              throw new Error("NAT VPS 必须填写公网映射端口");
            service.publicPort =
              service.access === "argo" ? 0 : service.port;
          }
        }
        state.services = state.services.filter(
          (item) =>
            item.id !== service.id &&
            !(item.protocol === service.protocol && item.access === service.access),
        );
        state.services.push(service);
      }

      if (
        !state.camouflage &&
        services.some((service) => service.protocol === "vless-ws") &&
        vps.zoneId &&
        vps.zoneName
      ) {
        if (!vps.accountId) throw new Error("部署共享伪装站前，请先绑定 Cloudflare Account 和 Zone");
        const domain = await step("检查共享伪装站 Edge 证书覆盖", () =>
          cf.edgeHostname(vps.zoneId, `web-${vps.namespace}.${vps.zoneName}`),
        );
        state.camouflage = { domain, port: await this.allocatePort(state, vps) };
      }
      if (services.some((service) => service.protocol === "vless-ws") || state.camouflage) {
        await step("安装 / 更新 Caddy 伪装站与 WebSocket 入口", () =>
          this.ssh.fq(vps, "core update caddy"),
        );
      }

      const hasArgo =
        state.services.some((service) => service.access === "argo") ||
        state.websites.some((website) => website.access === "argo") ||
        !!state.camouflage;
      const ingress = tunnelIngress(state);
      const tunnelChanged =
        previousTunnelSignature !== tunnelIngressSignature(state);
      if (new Set(ingress.map((item) => item.hostname)).size !== ingress.length)
        throw new Error("Tunnel hostname 重复，请为每项服务选择不同域名");

      // Adding an unrelated protocol (for example Hysteria2 direct) must not
      // fetch a Tunnel token, rewrite ingress or reinstall cloudflared.
      if (hasArgo && (tunnelChanged || !vps.tunnelId || state.disableTunnel)) {
        if (!vps.zoneId || !vps.zoneName || !vps.accountId)
          throw new Error("创建 Argo Tunnel 前请先绑定 Cloudflare Account 和 Zone");
        const tunnel = await step("准备此 VPS 的固定 Tunnel", () =>
          cf.tunnel(vps),
        );
        if (tunnel.created) {
          undo.push(async () => {
            await cf.request(
              `/accounts/${vps.accountId}/cfd_tunnel/${tunnel.id}`,
              "DELETE",
            );
          });
        }
        const oldVps = vps;
        vps = { ...vps, tunnelId: tunnel.id };
        state.tunnelToken = tunnel.token;
        state.disableTunnel = false;
        this.store.saveVps(vps);
        undo.push(async () => { this.store.saveVps(oldVps); });

        undo.push(
          await step("更新 Tunnel 多端口路由", () =>
            cf.tunnelConfig(vps.accountId, tunnel.id, ingress, previousTunnelHosts),
          ),
        );
        await step("安装 / 更新 cloudflared", (_report, stepSignal) =>
          this.ssh.fq(vps, "core update cloudflared", undefined, 300000, stepSignal),
        );
      } else if (!hasArgo && tunnelChanged && vps.tunnelId) {
        await this.updateTunnel(vps, state, step, undo, previousTunnelHosts);
      }

      if (state.camouflage) {
        if (!vps.zoneId || !vps.tunnelId) throw new Error("共享伪装站需要 Cloudflare Zone 和 Tunnel");
        const dns = await step("配置共享伪装站 Tunnel DNS", () =>
          cf.dns(vps.zoneId, state.camouflage!.domain, "CNAME", `${vps.tunnelId}.cfargotunnel.com`, true),
        );
        undo.push(dns.undo);
      }

      // 所有 DNS 和 Origin Rule 在同一批次中执行，任何失败立即触发统一补偿。
      for (const service of services) {
        const needsDNS = service.access !== "direct" || !!service.domain;
        if (!needsDNS) continue;
        if (!vps.zoneId || !vps.zoneName)
          throw new Error("请选择 Cloudflare Zone");
        if (
          service.domain !== vps.zoneName &&
          !service.domain.endsWith(`.${vps.zoneName}`)
        )
          throw new Error(`域名不属于当前 Cloudflare Zone：${service.domain}`);

        if (service.access === "argo") {
          if (!vps.tunnelId)
            throw new Error("Argo Tunnel 尚未创建，无法配置 DNS");
          const dns = await step("配置 Tunnel DNS", () =>
            cf.dns(
              vps.zoneId,
              service.domain,
              "CNAME",
              `${vps.tunnelId}.cfargotunnel.com`,
              true,
            ),
          );
          undo.push(dns.undo);
          continue;
        }

        const type = vps.publicAddress.includes(":") ? "AAAA" : "A";
        const dns = await step("配置域名解析", () =>
          cf.dns(
            vps.zoneId,
            service.domain,
            type,
            vps.publicAddress,
            service.access === "cdn",
          ),
        );
        undo.push(dns.undo);

        if (service.access === "cdn") {
          if (service.edgePort === service.publicPort) {
            undo.push(
              await step("清理不再需要的 Edge 回源规则", () =>
                cf.removeOriginRule(vps.zoneId, service.domain),
              ),
            );
          } else {
            undo.push(
              await step("配置 Edge 到公网回源端口", () =>
                cf.originRule(
                  vps.zoneId,
                  service.domain,
                  service.publicPort,
                ),
              ),
            );
          }
        }
      }

      await step("预检查、应用、验证与失败回滚", () =>
        this.ssh.fq(vps, "apply", state),
      );
      const synchronized = await this.sync(vps, step);
      this.notify();
      return { deployed: services.length, ...synchronized };
    } catch (error) {
      return compensate(undo, error);
    }
  }
 private async deployInner(
    vps: VPS,
    service: Service | undefined,
    website: Website | undefined,
    step: Step,
  ) {
    if (service) service = serviceSchema.parse(service);
    if (website) website = websiteSchema.parse(website);
    const undo: (() => Promise<void>)[] = [];
    try {
      await this.ensureFqCurrent(vps, step);
      let state = await step("读取远程真实配置", () => this.ssh.state(vps));
      const previousTunnelHosts = tunnelIngress(state).flatMap((r) => r.hostname ? [r.hostname] : []);
      state = {
        ...state,
        schemaVersion: 1,
        hostId: vps.id,
        hostName: vps.name,
        kind: vps.kind,
        publicAddress: vps.publicAddress,
        namespace: vps.namespace,
        zoneName: vps.zoneName,
      };
      const initialBackup = await step("备份远程配置", () =>
        this.ssh.fq<{ backupId: string }>(vps, "backup"),
      );
      undo.push(async () => {
        await this.ssh.run(
          vps,
          `${vps.username === "root" ? "" : "sudo -n "}/usr/local/bin/fq restore ${shellQuote(initialBackup.backupId)} --json`,
        );
      });
      if (!state.hostId || (!state.services.length && !state.websites.length && !state.camouflage)) {
        await step("初始化 fq 主机标识", () =>
          this.ssh.fq(vps, "apply", state),
        );
      }
      if (
        ((service && service.access !== "direct") ||
          (website && website.access !== "direct")) &&
        (!vps.zoneId || !vps.zoneName)
      )
        throw new Error("请选择 Cloudflare Zone");
      if (
        service &&
        !["snell", "vless-reality"].includes(service.protocol) &&
        service.access !== "argo" &&
        (!vps.zoneId || !vps.zoneName)
      )
        throw new Error("该协议需要 TLS 证书，请先绑定 Cloudflare Zone");
      if (service) {
        service = { ...service };
        const generated = !service.domain;
        if (generated && vps.zoneName)
          service.domain = `${service.access === "cdn" ? "cdn" : service.access === "argo" ? "argo" : "node"}.${vps.namespace}.${vps.zoneName}`;
        if (service.protocol === "vless-ws") {
          service.edgeScheme ||= "https";
          if (!service.edgePort) service.edgePort = service.edgeScheme === "http" ? 80 : 443;
        }
        if (
          service.access !== "direct" &&
          !(service.access === "cdn" && service.edgeScheme === "http")
        ) {
          const current = service;
          const cf = new Cloudflare(this.store.settings(), undefined, (account, tunnel, hosts) => this.store.saveLocal(`tunnelRoutes:${account}:${tunnel}`, hosts));
          service.domain = await step("检查 Cloudflare 边缘证书覆盖", () =>
            cf.edgeHostname(
              vps.zoneId,
              current.domain,
              generated
                ? `${current.access}-${vps.namespace}.${vps.zoneName}`
                : undefined,
            ),
          );
        }
      }
      if (website && website.access !== "direct") {
        const current = website;
        const cf = new Cloudflare(this.store.settings(), undefined, (account, tunnel, hosts) => this.store.saveLocal(`tunnelRoutes:${account}:${tunnel}`, hosts));
        await step("检查网站边缘证书覆盖", () =>
          cf.edgeHostname(vps.zoneId, current.domain),
        );
      }
      const certificateHosts = [
        ...(service &&
        !["snell", "vless-reality"].includes(service.protocol) &&
        (service.protocol === "vless-ws" || service.access !== "argo")
          ? [service.domain]
          : []),
        ...(website && website.access !== "argo" ? [website.domain] : []),
      ];
      const needsCert =
        (service &&
          service.protocol !== "snell" &&
          service.protocol !== "vless-reality" &&
          (service.protocol === "vless-ws" || service.access !== "argo")) ||
        (website && website.access !== "argo");
      if (
        needsCert &&
        (!state.certificate ||
          Date.parse(state.certificate.notAfter) < Date.now() + 30 * 86400000 ||
          certificateHosts.some(
            (host) =>
              !state.certificate?.domains?.some((pattern) =>
                matchesDNSName(pattern, host),
              ),
          ))
      ) {
        const issued = await step("DNS-01 申请独立泛域名证书", () =>
          this.certificates.issue(vps, certificateHosts, state),
        );
        state.certificate = issued.certificate;
      }
      if (service) {
        service = { ...service };
        if (service.protocol === "vless-ws") {
          const shared = state.services.find((item) => item.protocol === "vless-ws");
          service.port = service.port || shared?.port || await this.allocatePort(state, vps);
          const sharedPublic = state.services.find((item) => item.protocol === "vless-ws" && item.access !== "argo")?.publicPort;
          if (service.access === "argo") service.publicPort = 0;
          else service.publicPort = service.publicPort || sharedPublic || service.port;
          for (const previous of state.services.filter((item) => item.protocol === "vless-ws" && item.access !== "argo" && service!.access !== "argo")) {
            if (previous.publicPort !== service.publicPort) throw new Error("VLESS + WS 的直连与 CDN 必须共用同一个公网映射端口");
          }
        } else {
          if (!service.port) {
            if (vps.kind === "nat") throw new Error("NAT VPS 必须填写内部监听端口");
            service.port = await this.allocatePort(state, vps);
          }
          if (!service.publicPort) {
            if (vps.kind === "nat" && service.access !== "argo") throw new Error("NAT VPS 必须填写公网映射端口");
            service.publicPort = service.access === "argo" ? 0 : service.port;
          }
        }
        if (!service.domain && vps.zoneName)
          service.domain = `${service.access === "cdn" ? "cdn" : service.access === "argo" ? "argo" : "node"}.${vps.namespace}.${vps.zoneName}`;
        state.services = [
          ...state.services.filter(
            (s) =>
              s.id !== service!.id &&
              !(s.protocol === service!.protocol && s.access === service!.access),
          ),
          service,
        ];
      }
      if (website || service?.protocol === "vless-ws") {
        await step("安装并校验 Caddy", () =>
          this.ssh.fq(vps, "core update caddy"),
        );
      }
      if (website) {
        state.websites = [
          ...state.websites.filter((w) => w.id !== website!.id),
          website,
        ];
      }
      const item = service || website;
      if (!item) throw new Error("缺少部署配置");
      const needsDNS = item.access !== "direct" || !!item.domain;
      if (needsDNS) {
        if (!vps.zoneId || !vps.zoneName)
          throw new Error("请选择 Cloudflare Zone");
        if (
          item.domain !== vps.zoneName &&
          !item.domain.endsWith(`.${vps.zoneName}`)
        )
          throw new Error("域名不在所选 Zone 下");
        const cf = new Cloudflare(this.store.settings(), undefined, (account, tunnel, hosts) => this.store.saveLocal(`tunnelRoutes:${account}:${tunnel}`, hosts));
        if (item.access === "argo") {
          const tunnel = await step("准备此 VPS 的固定 Tunnel", () =>
            cf.tunnel(vps),
          );
          if (tunnel.created)
            undo.push(async () => {
              await cf.request(
                `/accounts/${vps.accountId}/cfd_tunnel/${tunnel.id}`,
                "DELETE",
              );
            });
          const oldVps = vps;
          vps = { ...vps, tunnelId: tunnel.id };
          state.tunnelToken = tunnel.token;
          state.disableTunnel = false;
          const ingress = tunnelIngress(state);
          if (new Set(ingress.map((i) => i.hostname)).size !== ingress.length)
            throw new Error("Tunnel hostname 重复，请为每项服务选择不同域名");
          undo.push(
            await step("更新 Tunnel 多端口路由", () =>
              cf.tunnelConfig(vps.accountId, tunnel.id, ingress, previousTunnelHosts),
            ),
          );
          const dns = await step("配置 Tunnel DNS", () =>
            cf.dns(
              vps.zoneId,
              item.domain,
              "CNAME",
              `${tunnel.id}.cfargotunnel.com`,
              true,
            ),
          );
          undo.push(dns.undo);
          await step("安装 cloudflared", (_report, stepSignal) =>
            this.ssh.fq(vps, "core update cloudflared", undefined, 300000, stepSignal),
          );
          this.store.saveVps(vps);
          undo.push(async () => {
            this.store.saveVps(oldVps);
          });
        } else {
          const type = vps.publicAddress.includes(":") ? "AAAA" : "A";
          const dns = await step("配置域名解析", () =>
            cf.dns(
              vps.zoneId,
              item.domain,
              type,
              vps.publicAddress,
              item.access === "cdn",
            ),
          );
          undo.push(dns.undo);
          if (item.access === "cdn") {
            if (item.edgePort === item.publicPort) {
              undo.push(await step("清理不再需要的 Edge 回源规则", () =>
                cf.removeOriginRule(vps.zoneId, item.domain),
              ));
            } else {
              undo.push(await step("配置 Edge 到公网回源端口", () =>
                cf.originRule(vps.zoneId, item.domain, item.publicPort),
              ));
            }
          }
        }
      }
      if (item.access !== "argo" && vps.tunnelId) {
        await this.updateTunnel(vps, state, step, undo, previousTunnelHosts);
      }
      await step("预检查、应用、验证与失败回滚", () =>
        this.ssh.fq(vps, "apply", state),
      );
      const synchronized = await this.sync(vps, step);
      this.notify();
      return synchronized;
    } catch (e) {
      return compensate(undo, e);
    }
  }
  async deployCamouflage(originalVps: VPS, step: Step) {
    const action = async () => {
      const undo: (() => Promise<void>)[] = [];
      let vps = originalVps;
      try {
        if (!vps.zoneId || !vps.zoneName || !vps.accountId) throw new Error("请先绑定 Cloudflare Zone 和 Account");
        await this.ensureFqCurrent(vps, step);
      let state = await step("读取远程真实配置", () => this.ssh.state(vps));
        state = { ...state, schemaVersion: 1, hostId: vps.id, hostName: vps.name, kind: vps.kind, publicAddress: vps.publicAddress, namespace: vps.namespace, zoneName: vps.zoneName };
        const previousTunnelHosts = tunnelIngress(state).flatMap((r) => r.hostname ? [r.hostname] : []);
        const previousSignature = tunnelIngressSignature(state);
        const backup = await step("备份远程配置", () => this.ssh.fq<{ backupId: string }>(vps, "backup"));
        undo.push(async () => { await this.ssh.run(vps, `${vps.username === "root" ? "" : "sudo -n "}/usr/local/bin/fq restore ${shellQuote(backup.backupId)} --json`); });
        const cf = new Cloudflare(this.store.settings(), undefined, (account, tunnel, hosts) => this.store.saveLocal(`tunnelRoutes:${account}:${tunnel}`, hosts));
        const domain = await step("检查共享伪装站 Edge 证书覆盖", () => cf.edgeHostname(vps.zoneId, state.camouflage?.domain || `web-${vps.namespace}.${vps.zoneName}`));
        if (!state.camouflage) state.camouflage = { domain, port: await this.allocatePort(state, vps) };
        else state.camouflage.domain = domain;
        await step("安装 / 更新 Caddy 伪装站入口", () => this.ssh.fq(vps, "core update caddy"));
        const ingress = tunnelIngress(state);
        if (new Set(ingress.map((item) => item.hostname)).size !== ingress.length) throw new Error("Tunnel hostname 重复");
        if (previousSignature !== tunnelIngressSignature(state) || !vps.tunnelId || state.disableTunnel || state.camouflage) {
          const tunnel = await step("准备此 VPS 的固定 Tunnel", () => cf.tunnel(vps));
          if (tunnel.created) undo.push(async () => cf.request(`/accounts/${vps.accountId}/cfd_tunnel/${tunnel.id}`, "DELETE"));
          const oldVps = vps;
          vps = { ...vps, tunnelId: tunnel.id };
          state.tunnelToken = tunnel.token;
          state.disableTunnel = false;
          this.store.saveVps(vps);
          undo.push(async () => { this.store.saveVps(oldVps); });
          undo.push(await step("更新 Tunnel 多端口路由", () => cf.tunnelConfig(vps.accountId, tunnel.id, ingress, previousTunnelHosts)));
          await step("安装 / 更新 cloudflared", () => this.ssh.fq(vps, "core update cloudflared"));
        }
        if (!vps.tunnelId) throw new Error("Tunnel 尚未创建");
        const dns = await step("配置共享伪装站 Tunnel DNS", () => cf.dns(vps.zoneId, state.camouflage!.domain, "CNAME", `${vps.tunnelId}.cfargotunnel.com`, true));
        undo.push(dns.undo);
        state.disableTunnel = false;
        await step("预检查、应用并验证共享伪装站", () => this.ssh.fq(vps, "apply", state));
        const synchronized = await this.sync(vps, step);
        this.notify();
        return synchronized;
      } catch (error) { return compensate(undo, error); }
    };
    return withCloudflareMutation(action);
  }

  private async updateTunnel(
    vps: VPS,
    state: RemoteState,
    step: Step,
    undo: (() => Promise<void>)[],
    previousTunnelHosts: string[],
  ) {
    const ingress = tunnelIngress(state);
    const cf = new Cloudflare(this.store.settings(), undefined, (account, tunnel, hosts) => this.store.saveLocal(`tunnelRoutes:${account}:${tunnel}`, hosts));
    undo.push(
      await step("更新 Tunnel 路由", () =>
        cf.tunnelConfig(vps.accountId, vps.tunnelId, ingress, previousTunnelHosts),
      ),
    );
    state.disableTunnel = ingress.length === 0;
  }
  async remove(vps: VPS, kind: "service" | "website", id: string, step: Step) {
    const action = async () => {
      await this.ensureFqCurrent(vps, step);
      const state = await step("读取真实配置", () => this.ssh.state(vps));
      const previousTunnelHosts = tunnelIngress(state).flatMap((r) => r.hostname ? [r.hostname] : []);
      const previousTunnelSignature = tunnelIngressSignature(state);
      const backup = await step("备份配置", () =>
        this.ssh.fq<{ backupId: string }>(vps, "backup"),
      );
      const undo: (() => Promise<void>)[] = [
        async () => {
          await this.ssh.run(
            vps,
            `${vps.username === "root" ? "" : "sudo -n "}/usr/local/bin/fq restore ${shellQuote(backup.backupId)} --json`,
          );
        },
      ];
      try {
        if (kind === "service")
          state.services = state.services.filter((s) => s.id !== id);
        else state.websites = state.websites.filter((w) => w.id !== id);
        if (
          vps.tunnelId &&
          previousTunnelSignature !== tunnelIngressSignature(state)
        ) {
          await this.updateTunnel(vps, state, step, undo, previousTunnelHosts);
        }
        await step("应用、验证与失败回滚", () =>
          this.ssh.fq(vps, "apply", state),
        );
        return await this.sync(vps, step);
      } catch (e) {
        return compensate(undo, e);
      }
    };
    return withCloudflareMutation(action);
  }
  private async allocatePort(state: RemoteState, vps: VPS) {
    const used = new Set(state.services.map((s) => s.port));
    for (const s of state.services) if (s.backendPort) used.add(s.backendPort);
    for (const w of state.websites) used.add(w.port);
    if (state.camouflage) used.add(state.camouflage.port);
    const out = await this.ssh.run(vps, "ss -H -lntu");
    for (const line of out.split("\n")) {
      const match = line.match(/\s[^\s]+:(\d+)\s/);
      if (match) used.add(Number(match[1]));
    }
    for (let port = 20000; port < 60000; port++)
      if (!used.has(port)) return port;
    throw new Error("无可用端口");
  }
}

