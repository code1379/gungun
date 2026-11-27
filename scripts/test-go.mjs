import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ensureGo } from "./ensure-go.mjs";

const go = await ensureGo();
execFileSync(go, ["test", "-race", "./..."], {
  cwd: resolve("fq"),
  stdio: "inherit",
});
