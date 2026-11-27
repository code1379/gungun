import { describe, it, expect } from "vitest";
import { certificateExtraDomains } from "../apps/desktop/src/main/certificates";

describe("Let's Encrypt SAN 规划", () => {
  it("过滤被 namespace 通配符覆盖的域名，并保留通配符无法覆盖的入口", () => {
    expect(
      certificateExtraDomains("s2cp2.pangu.qzz.io", [
        "s2cp2.pangu.qzz.io",
        "hy2-direct.s2cp2.pangu.qzz.io",
        "vless-ws-direct.s2cp2.pangu.qzz.io",
        "cdn-s2cp2.pangu.qzz.io",
        "argo-s2cp2.pangu.qzz.io",
        "cdn-s2cp2.pangu.qzz.io",
        "deep.host.s2cp2.pangu.qzz.io",
      ]),
    ).toEqual([
      "cdn-s2cp2.pangu.qzz.io",
      "argo-s2cp2.pangu.qzz.io",
      "deep.host.s2cp2.pangu.qzz.io",
    ]);
  });
});
