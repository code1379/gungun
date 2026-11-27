import { randomUUID } from "node:crypto";
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
import { Cloudflare, compensate } from "./cloudflare";
import { Certificates } from "./certificates";
import type { Store } from "./store";
import type { SSH } from "./ssh";
import type { Step } from "./tasks";
import { shellQuote } from "./ssh";
const protocolDomainPrefix: Record<Service["protocol"], string> = {
  hysteria2: "hy2",
  tuic: "tuic",
  anytls: "anytls",
  snell: "snell",
  "vless-ws": "vless-ws",
  "vless-reality": "reality",
};
export class Orchestrator {
  readonly certificates: Certificates;
  private cfLane: Promise<unknown> = Promise.resolve();
  constructor(
    private store: Store,
    private ssh: SSH,
    private resources: string,
    private notify: () => void,
    certDir: string,
  ) {
    this.certificates = new Certificates(store, ssh, certDir);
  }
  async install(vps: VPS, step: Step) {
    await step("连接 VPS 并识别 CPU", () => this.ssh.test(vps));
    const arch = (await this.ssh.run(vps, "uname -m")).trim();
    const target =
      arch === "x86_64"
        ? "amd64"
        : ["aarch64", "arm64"].includes(arch)
          ? "arm64"
          : null;
    if (!target) throw new Error(`不支持的 CPU：${arch}`);
    const remote = `/tmp/gungun-fq-${randomUUID()}`;
    await step("上传 fq", (reportTransfer) =>
      this.ssh.upload(
        vps,
        join(this.resources, `fq-linux-${target}`),
        remote,
        reportTransfer,
      ),
    );
    await step("安装 fq 与服务单元", async () => {
      await this.ssh.run(
        vps,
        `${vps.username === "root" ? "" : "sudo -n "}install -m 0755 ${shellQuote(remote)} /usr/local/bin/fq.next && ${vps.username === "root" ? "" : "sudo -n "}mv -f /usr/local/bin/fq.next /usr/local/bin/fq && rm -f ${shellQuote(remote)}`,
      );
      return this.ssh.fq(vps, "install");
    });
    await step("安装并校验 sing-box", () =>
      this.ssh.fq(vps, "core update sing-box", undefined, 10 * 60 * 1000),
    );
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
  ) {
    const action = async () => {
      if (website) return this.deployInner(vps, undefined, website, step);
      if (!services?.length) throw new Error("请选择至少一个协议和接入方式");
      return this.deployServices(vps, services, step);
    };
    const run = this.cfLane.then(action, action);
    this.cfLane = run.catch(() => {});
    return run;
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
      if (!state.hostId || (!state.services.length && !state.websites.length)) {
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

      const cf = new Cloudflare(this.store.settings());
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

      const hasArgo =
        state.services.some((service) => service.access === "argo") ||
        state.websites.some((website) => website.access === "argo");
      const ingress = [
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
      ];
      if (new Set(ingress.map((item) => item.hostname)).size !== ingress.length)
        throw new Error("Tunnel hostname 重复，请为每项服务选择不同域名");

      if (hasArgo) {
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
        undo.push(async () => this.store.saveVps(oldVps));

        undo.push(
          await step("更新 Tunnel 多端口路由", () =>
            cf.tunnelConfig(vps.accountId, tunnel.id, ingress),
          ),
        );
        await step("安装 / 更新 cloudflared", () =>
          this.ssh.fq(vps, "core update cloudflared"),
        );
      } else if (vps.tunnelId) {
        await this.updateTunnel(vps, state, step, undo);
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
      let state = await step("读取远程真实配置", () => this.ssh.state(vps));
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
      if (!state.hostId || (!state.services.length && !state.websites.length)) {
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
          const cf = new Cloudflare(this.store.settings());
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
        const cf = new Cloudflare(this.store.settings());
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
          for (const previous of state.services.filter((item) => item.protocol === "vless-ws" && item.access !== "argo" && service.access !== "argo")) {
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
      if (website) {
        await step("安装并校验 Caddy", () =>
          this.ssh.fq(vps, "core update caddy"),
        );
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
        const cf = new Cloudflare(this.store.settings());
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
          const ingress = [
            ...state.services
              .filter((s) => s.access === "argo")
              .map((s) => ({
                hostname: s.domain,
                service: s.protocol === "vless-ws" ? `https://127.0.0.1:${s.port}` : `http://127.0.0.1:${s.port}`,
                ...(s.protocol === "vless-ws" ? { originRequest: { originServerName: s.domain } } : {}),
              })),
            ...state.websites
              .filter((w) => w.access === "argo")
              .map((w) => ({
                hostname: w.domain,
                service: `http://127.0.0.1:${w.port}`,
              })),
          ];
          if (new Set(ingress.map((i) => i.hostname)).size !== ingress.length)
            throw new Error("Tunnel hostname 重复，请为每项服务选择不同域名");
          undo.push(
            await step("更新 Tunnel 多端口路由", () =>
              cf.tunnelConfig(vps.accountId, tunnel.id, ingress),
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
          await step("安装 cloudflared", () =>
            this.ssh.fq(vps, "core update cloudflared"),
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
        await this.updateTunnel(vps, state, step, undo);
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
  private async updateTunnel(
    vps: VPS,
    state: RemoteState,
    step: Step,
    undo: (() => Promise<void>)[],
  ) {
    const ingress = [
      ...state.services
        .filter((s) => s.access === "argo")
        .map((s) => ({
          hostname: s.domain,
          service: s.protocol === "vless-ws" ? `https://127.0.0.1:${s.port}` : `http://127.0.0.1:${s.port}`,
          ...(s.protocol === "vless-ws" ? { originRequest: { originServerName: s.domain } } : {}),
        })),
      ...state.websites
        .filter((w) => w.access === "argo")
        .map((w) => ({
          hostname: w.domain,
          service: `http://127.0.0.1:${w.port}`,
        })),
    ];
    const cf = new Cloudflare(this.store.settings());
    undo.push(
      await step("更新 Tunnel 路由", () =>
        cf.tunnelConfig(vps.accountId, vps.tunnelId, ingress),
      ),
    );
    state.disableTunnel = ingress.length === 0;
  }
  async remove(vps: VPS, kind: "service" | "website", id: string, step: Step) {
    const action = async () => {
      const state = await step("读取真实配置", () => this.ssh.state(vps));
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
        if (vps.tunnelId) await this.updateTunnel(vps, state, step, undo);
        await step("应用、验证与失败回滚", () =>
          this.ssh.fq(vps, "apply", state),
        );
        return await this.sync(vps, step);
      } catch (e) {
        return compensate(undo, e);
      }
    };
    const run = this.cfLane.then(action, action);
    this.cfLane = run.catch(() => {});
    return run;
  }
  private async allocatePort(state: RemoteState, vps: VPS) {
    const used = new Set(state.services.map((s) => s.port));
    for (const w of state.websites) used.add(w.port);
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

