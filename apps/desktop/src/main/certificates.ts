import acme from "acme-client";
import { Resolver } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  matchesDNSName,
  type RemoteState,
  type VPS,
} from "@gungun/domain";
import { Cloudflare } from "./cloudflare";
import type { SSH } from "./ssh";
import type { Store } from "./store";

/**
 * 返回 CSR 中除基础域名和一级通配符以外真正需要的 SAN。
 * *.namespace.zone 已经覆盖 foo.namespace.zone，不能再把 foo.namespace.zone
 * 作为独立 SAN 提交给 Let's Encrypt，否则会被判定为 redundant identifier。
 */
export function certificateExtraDomains(
  baseDomain: string,
  candidates: string[],
) {
  const wildcard = `*.${baseDomain}`;
  const seen = new Set([baseDomain.toLowerCase(), wildcard.toLowerCase()]);
  const result: string[] = [];
  for (const candidate of candidates) {
    const name = candidate.trim().toLowerCase();
    if (!name || seen.has(name) || matchesDNSName(wildcard, name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

export class Certificates {
  private accountKey: Promise<Buffer> | undefined;
  constructor(
    private store: Store,
    private ssh: SSH,
    private directory: string,
  ) {}
  async issue(
    vps: VPS,
    extraDomains: string[] = [],
    currentState?: RemoteState,
  ) {
    const settings = this.store.settings();
    if (!settings.acmeEmail) throw new Error("请在设置中填写 ACME 邮箱");
    if (!vps.zoneName || !vps.zoneId)
      throw new Error("请先选择 Cloudflare Zone");
    const domain = `${vps.namespace}.${vps.zoneName}`;
    const remote = currentState ?? (await this.ssh.state(vps));
    const domains = certificateExtraDomains(domain, [
      ...remote.services
        .filter(
          (s) =>
            s.access !== "argo" &&
            !["snell", "vless-reality"].includes(s.protocol) &&
            s.domain,
        )
        .map((s) => s.domain),
      ...remote.websites
        .filter((w) => w.access !== "argo")
        .map((w) => w.domain),
      ...extraDomains,
    ]);
    const { csr } = await this.ssh.fq<{ csr: string }>(vps, "cert csr", {
      domain,
      domains,
    });
    this.accountKey ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, "acme-account.pem");
      try {
        return await readFile(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        const key = await acme.crypto.createPrivateKey();
        await writeFile(path, key, { mode: 0o600, flag: "wx" });
        return key;
      }
    })();
    const accountKey = await this.accountKey;
    const client = new acme.Client({
      directoryUrl: acme.directory.letsencrypt.production,
      accountKey,
    });
    const cf = new Cloudflare(settings);
    const cleanup = new Map<string, () => Promise<void>>();
    try {
      const cert = await client.auto({
        csr,
        email: settings.acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ["dns-01"],
        challengeCreateFn: async (auth, challenge, keyAuthorization) => {
          if (challenge.type !== "dns-01") throw new Error("只允许 DNS-01");
          const name = `_acme-challenge.${auth.identifier.value}`;
          const undo = await cf.createChallenge(
            vps.zoneId,
            name,
            keyAuthorization,
          );
          cleanup.set(challenge.token, undo);
          const resolver = new Resolver({ timeout: 3000, tries: 1 });
          resolver.setServers(["1.1.1.1", "8.8.8.8"]);
          for (let i = 0; i < 40; i++) {
            try {
              const records = await resolver.resolveTxt(name);
              if (records.some((r) => r.join("") === keyAuthorization)) return;
            } catch {
              /* DNS 尚未传播 */
            }
            await new Promise((r) => setTimeout(r, 3000));
          }
          throw new Error("DNS-01 TXT 在 120 秒内未传播");
        },
        challengeRemoveFn: async (_auth, challenge) => {
          const undo = cleanup.get(challenge.token);
          if (undo) {
            await undo();
            cleanup.delete(challenge.token);
          }
        },
      });
      const installed = await this.ssh.fq<{
        notAfter: string;
        backupId: string;
      }>(vps, "cert install", { certificate: cert });
      return {
        ...installed,
        certificate: {
          notAfter: installed.notAfter,
          domain,
          domains: [domain, `*.${domain}`, ...domains],
        },
      };
    } finally {
      for (const undo of cleanup.values()) await undo();
    }
  }
}
