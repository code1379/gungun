import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ensureGo } from "./ensure-go.mjs";

const go = await ensureGo();
mkdirSync("resources/bin", { recursive: true });
for (const arch of ["amd64", "arm64"])
  execFileSync(
    go,
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.version=${process.env.RELEASE_VERSION || "dev"}`,
      "-o",
      resolve(`resources/bin/fq-linux-${arch}`),
      "./cmd/fq",
    ],
    {
      cwd: "fq",
      env: { ...process.env, GOOS: "linux", GOARCH: arch, CGO_ENABLED: "0" },
      stdio: "inherit",
    },
  );
