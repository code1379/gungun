import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
if (process.platform === "darwin") {
  const script = fileURLToPath(new URL("./make-icon.swift", import.meta.url));
  const output = fileURLToPath(
    new URL("../apps/desktop/build/icon.png", import.meta.url),
  );
  mkdirSync(fileURLToPath(new URL("../apps/desktop/build", import.meta.url)), {
    recursive: true,
  });
  execFileSync("swift", [script, output], { stdio: "inherit" });
}
