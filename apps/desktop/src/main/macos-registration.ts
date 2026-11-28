import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";

const loadNative = createRequire(import.meta.url);
const registrationSchema = z.object({
  status: z.enum(["enabled", "requiresApproval"]),
  bundlePath: z.string().min(1),
  plistPath: z.string().min(1),
});
export function registerMacProxyService(
  helperBinary: string | undefined,
  platform = process.platform,
  load: (path: string) => unknown = loadNative,
) {
  if (platform !== "darwin")
    throw new Error("系统代理仅支持 macOS；当前平台无法验收");
  if (!helperBinary)
    throw new Error(
      "系统代理需要安装已签名的 Gungun.app；开发模式可使用本机核心，但不能注册特权辅助程序",
    );
  const path = join(
    dirname(helperBinary),
    "../Resources/native/gungun-service-registration.node",
  );
  let native: unknown;
  try {
    native = load(path);
  } catch (error) {
    throw new Error(
      `无法加载应用内系统代理注册模块：${path}；${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !native ||
    typeof native !== "object" ||
    !("registerService" in native) ||
    typeof native.registerService !== "function"
  )
    throw new Error("应用内系统代理注册模块接口无效，请重新构建 Gungun.app");
  // No child process: NSBundle.mainBundle must identify the actual Gungun app.
  const reply: unknown = native.registerService();
  if (typeof reply !== "string")
    throw new Error("系统代理注册模块返回格式无效");
  return registrationSchema.parse(JSON.parse(reply));
}
