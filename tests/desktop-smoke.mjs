import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { desktopSSHFixture } from "./desktop-ssh-fixture.mjs";
const dir = await mkdtemp(join(tmpdir(), "gungun-smoke-"));
const ssh = await desktopSSHFixture(dir);
const args = process.env.PACKAGED_APP ? [] : [resolve("apps/desktop")];
if (process.platform === "linux")
  args.unshift("--no-sandbox", "--ozone-platform=headless", "--disable-gpu");
const launchOptions = {
  ...(process.env.PACKAGED_APP
    ? { executablePath: process.env.PACKAGED_APP }
    : {
        executablePath: resolve(
          "apps/desktop/node_modules/electron/dist",
          process.platform === "darwin"
            ? "Electron.app/Contents/MacOS/Electron"
            : "electron",
        ),
      }),
  args,
  env: { ...process.env, GUNGUN_DATA_DIR: dir },
  timeout: 30000,
};
let app = await electron.launch(launchOptions);
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  const choose = async (label, option) => {
    const trigger = page.getByRole("combobox", { name: label, exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("option", { name: option, exact: typeof option === "string" })
      .click();
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  const generatedKey = await page.evaluate(
    (path) => window.gungun.invoke("generateKey", { path }),
    join(dir, "gungun-test-key"),
  );
  if (!generatedKey.ok) throw new Error(generatedKey.error);
  await expect(
    page.getByRole("heading", { name: "主控制台", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "连接第一台 VPS" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "VPS 管理", exact: true }).click();
  await page.getByRole("button", { name: "添加 VPS", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("名称", { exact: true }).fill("Smoke NAT");
  await choose("主机类型", /^NAT/);
  await page.getByLabel("服务器地址", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("SSH 端口", { exact: true }).fill(String(ssh.port));
  await page.getByLabel("SSH 登录密码", { exact: true }).fill(ssh.password);
  await page.getByRole("checkbox", { name: "与服务器地址相同" }).uncheck();
  await page.getByPlaceholder("例如 NAT 映射公网 IP").fill("203.0.113.7");
  await page.getByRole("button", { name: "保存 VPS", exact: true }).click();
  await expect(page.getByRole("button", { name: /Smoke NAT/ })).toBeVisible();
  const source = await page.evaluate(() => window.gungun.invoke("snapshot"));
  if (!source.ok) throw new Error(source.error);
  const vps = source.value.vps[0];
  const trust = await page.evaluate(
    (input) => window.gungun.invoke("trustHost", input),
    { address: `127.0.0.1:${ssh.port}`, fingerprint: ssh.fingerprint },
  );
  if (!trust.ok) throw new Error(trust.error);
  await page.getByRole("button", { name: /Smoke NAT/ }).click();
  await page.getByRole("button", { name: "安装 SSH 主密钥", exact: true }).click();
  await expect(page.getByText("SSH 密钥认证已启用", { exact: true })).toBeVisible();
  const afterKeyInstall = await page.evaluate(() => window.gungun.invoke("snapshot"));
  if (!afterKeyInstall.ok || afterKeyInstall.value.vps[0].auth !== "key" || afterKeyInstall.value.vps[0].password)
    throw new Error("Password-to-key onboarding did not complete");
  const opened = app.waitForEvent("window");
  const open = await page.evaluate(
    (id) => window.gungun.invoke("openWindow", { type: "terminal", id }),
    vps.id,
  );
  if (!open.ok) throw new Error(open.error);
  const terminal = await opened;
  // xterm 6 applies its live theme to the scrollable element. The legacy
  // .xterm-viewport retains a black background independently of that theme.
  const terminalSurface = terminal.locator(".xterm-scrollable-element");
  await expect(terminalSurface).toBeVisible();
  await expect
    .poll(async () => {
      const theme = await terminal.locator("html").getAttribute("data-theme");
      const background = await terminalSurface.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      return (
        background ===
        (theme === "dark" ? "rgb(23, 25, 28)" : "rgb(247, 248, 250)")
      );
    })
    .toBe(true);
  await expect.poll(() => ssh.shells).toBe(1);
  await terminal.evaluate(() => {
    window.smokeTerminalOutput = "";
    window.gungun.terminalData((text) => {
      window.smokeTerminalOutput += text;
    });
  });
  await page.getByRole("button", { name: "节点与订阅", exact: true }).click();
  await expect(page.getByRole("tab", { name: /链式代理/ })).toBeVisible();
  await page.getByRole("button", { name: "新建分组" }).click();
  await page.getByLabel("名称", { exact: true }).fill("Smoke Manual");
  await page.getByRole("button", { name: "保存分组" }).click();
  await expect(page.getByRole("tab", { name: /Smoke Manual/ })).toBeVisible();
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page
    .getByLabel("节点内容")
    .fill(
      "anytls://fixture-password@127.0.0.1:12345?sni=localhost#Smoke%20A\nanytls://other-password@127.0.0.1:12346?sni=localhost#Smoke%20B",
    );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "导入", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "Smoke A", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /链式代理/ }).click();
  await page.getByRole("button", { name: "创建链路" }).click();
  await page.getByLabel("链路名称").fill("Smoke HK → US");
  await choose("第一跳", "Smoke A · AnyTLS");
  await choose("最终出口", "Smoke B · AnyTLS");
  await page.getByRole("button", { name: "保存链路" }).click();
  await expect(
    page.getByRole("cell", { name: "Smoke HK → US 2 跳", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("全局最大并发").fill("7");
  await page.getByRole("button", { name: "保存设置" }).click();
  await mkdir("test-results", { recursive: true });
  await page.emulateMedia({ colorScheme: "light" });
  await choose("应用主题", "深色");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(terminal.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(terminalSurface).toHaveCSS(
    "background-color",
    "rgb(23, 25, 28)",
  );
  await expect
    .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe("dark");
  await page.locator(".page-content").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: "test-results/settings-dark.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await choose("应用主题", "浅色");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(terminal.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(terminalSurface).toHaveCSS(
    "background-color",
    "rgb(247, 248, 250)",
  );
  await expect
    .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe("light");
  await page.locator(".page-content").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: "test-results/settings-light.png" });
  await choose("应用主题", "跟随系统");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect
    .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe("system");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: "主控制台", exact: true }).click();
  await page.screenshot({ path: "test-results/desktop-light.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  console.log(
    "Theme smoke passed: persisted system/light/dark, nativeTheme source and live system preference changes.",
  );
  await expect(
    page.getByRole("heading", { name: "主控制台", exact: true }),
  ).toBeVisible();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/desktop.png" });
  if (process.env.GUNGUN_SCREENSHOT_LOG === "1")
    for (const name of [
      "desktop",
      "desktop-light",
      "settings-dark",
      "settings-light",
    ])
      console.log(
        "GUNGUN_UI_SCREENSHOT_" +
          name +
          ":" +
          (await readFile(`test-results/${name}.png`)).toString("base64"),
      );
  const snapshot = await page.evaluate(() => window.gungun.invoke("snapshot"));
  await terminal.evaluate(() => window.gungun.terminalInput("theme-echo\n"));
  await expect
    .poll(() => terminal.evaluate(() => window.smokeTerminalOutput))
    .toContain("received:theme-echo");
  if (ssh.shells !== 1)
    throw new Error("Theme change recreated the SSH session");
  console.log(
    "Terminal theme passed: actual SSH stream survived appearance changes without reconnecting.",
  );
  if (
    !snapshot.ok ||
    snapshot.value.nodes.length !== 2 ||
    snapshot.value.chains.length !== 1 ||
    snapshot.value.settings.concurrency !== 7 ||
    snapshot.value.settings.theme !== "system"
  )
    throw new Error("Persistent data integration failed");
  // Verify a saved explicit choice survives a real application restart.
  const saved = await page.evaluate(async () => {
    const current = await window.gungun.invoke("snapshot");
    if (!current.ok) return current;
    return window.gungun.invoke("saveSettings", {
      ...current.value.settings,
      theme: "light",
    });
  });
  if (!saved.ok) throw new Error(saved.error);
  await app.close();
  app = await electron.launch(launchOptions);
  const reopened = await app.firstWindow();
  await expect(
    reopened.getByRole("heading", { name: "主控制台", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe("light");
  await expect(reopened.locator("html")).toHaveAttribute("data-theme", "light");
  console.log(
    "Theme restart passed: saved light preference restored before the first application window.",
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Desktop smoke passed: fresh start, NAT VPS, import, tags, two-hop chain, settings and SQLite.",
  );
} catch (error) {
  const page = await app.firstWindow();
  console.log(
    "UI FAILURE STATE:",
    await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[role="combobox"], [role="option"], [data-slot="select-content"]',
        ),
      ].map((el) => ({
        role: el.getAttribute("role"),
        text: el.textContent,
        expanded: el.getAttribute("aria-expanded"),
        state: el.getAttribute("data-state"),
        rect: el.getBoundingClientRect().toJSON(),
        style: {
          visibility: getComputedStyle(el).visibility,
          display: getComputedStyle(el).display,
        },
      })),
    ),
  );
  if (process.env.GUNGUN_SCREENSHOT_LOG === "1")
    console.log(
      "GUNGUN_UI_SCREENSHOT_failure:" +
        (await page.screenshot()).toString("base64"),
    );
  throw error;
} finally {
  await app.close();
  await ssh.close();
  await rm(dir, { recursive: true, force: true });
}
