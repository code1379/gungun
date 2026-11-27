import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = await mkdtemp(join(tmpdir(), "gungun-smoke-"));
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
    await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
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
  await page.getByLabel("SSH 地址", { exact: true }).fill("100.100.1.2");
  await page.getByLabel("公网地址", { exact: true }).fill("203.0.113.7");
  await page.getByRole("button", { name: "保存 VPS", exact: true }).click();
  await expect(page.getByRole("button", { name: /Smoke NAT/ })).toBeVisible();
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
  await expect.poll(() => app.evaluate(({nativeTheme}) => nativeTheme.themeSource)).toBe("dark");
  await page.screenshot({ path: "test-results/settings-dark.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await choose("应用主题", "浅色");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect.poll(() => app.evaluate(({nativeTheme}) => nativeTheme.themeSource)).toBe("light");
  await page.screenshot({ path: "test-results/settings-light.png" });
  await choose("应用主题", "跟随系统");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect.poll(() => app.evaluate(({nativeTheme}) => nativeTheme.themeSource)).toBe("system");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: "主控制台", exact: true }).click();
  await page.screenshot({ path: "test-results/desktop-light.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  console.log("Theme smoke passed: persisted system/light/dark, nativeTheme source and live system preference changes.");
  await expect(
    page.getByRole("heading", { name: "主控制台", exact: true }),
  ).toBeVisible();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/desktop.png" });
  if (process.env.GUNGUN_SCREENSHOT_LOG === "1")
    for (const name of ["desktop", "desktop-light", "settings-dark", "settings-light"])
      console.log("GUNGUN_UI_SCREENSHOT_" + name + ":" + (await readFile(`test-results/${name}.png`)).toString("base64"));
  const snapshot = await page.evaluate(() => window.gungun.invoke("snapshot"));
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
    return window.gungun.invoke("saveSettings", { ...current.value.settings, theme: "light" });
  });
  if (!saved.ok) throw new Error(saved.error);
  await app.close();
  app = await electron.launch(launchOptions);
  const reopened = await app.firstWindow();
  await expect(reopened.getByRole("heading", { name: "主控制台", exact: true })).toBeVisible();
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("light");
  await expect(reopened.locator("html")).toHaveAttribute("data-theme", "light");
  console.log("Theme restart passed: saved light preference restored before the first application window.");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Desktop smoke passed: fresh start, NAT VPS, import, tags, two-hop chain, settings and SQLite.",
  );
} catch (error) {
  const page = await app.firstWindow();
  console.log("UI FAILURE STATE:", await page.evaluate(() => [...document.querySelectorAll('[role="combobox"], [role="option"], [data-slot="select-content"]')].map(el => ({role:el.getAttribute("role"),text:el.textContent,expanded:el.getAttribute("aria-expanded"),state:el.getAttribute("data-state"),rect:el.getBoundingClientRect().toJSON(),style: {visibility:getComputedStyle(el).visibility,display:getComputedStyle(el).display}}))));
  if (process.env.GUNGUN_SCREENSHOT_LOG === "1") console.log("GUNGUN_UI_SCREENSHOT_failure:" + (await page.screenshot()).toString("base64"));
  throw error;
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}

