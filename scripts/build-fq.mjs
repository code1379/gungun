import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
mkdirSync("resources/bin", { recursive: true });
for (const arch of ["amd64", "arm64"])
  execFileSync(
    process.env.GO_BINARY || "go",
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
