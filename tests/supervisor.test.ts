import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { availablePort } from "../apps/desktop/src/main/local-runtime";
it("主进程被 SIGKILL 后监管管道关闭，核心进程释放端口（模拟核心）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gungun-supervisor-"));
  const port = await availablePort();
  const path = join(dir, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: port }],
      outbounds: [],
    }),
  );
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,${JSON.stringify([resolve("resources/helpers/core-supervisor.cjs"), resolve("tests/fixtures/mock-core.cjs"), "run", "-c", path])},{stdio:['pipe','ignore','ignore']});process.stdout.write(String(child.pid)+'\\n');setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let supervisor = 0;
  parent.stdout.on(
    "data",
    (b: Buffer) => (supervisor = Number(b.toString().trim())),
  );
  try {
    await expect
      .poll(
        () =>
          new Promise<boolean>((resolve) => {
            const socket = createConnection({ host: "127.0.0.1", port });
            socket.once("connect", () => {
              socket.destroy();
              resolve(true);
            });
            socket.once("error", () => resolve(false));
          }),
      )
      .toBe(true);
    parent.kill("SIGKILL");
    await expect
      .poll(async () => {
        try {
          return await availablePort(port);
        } catch {
          return 0;
        }
      })
      .toBe(port);
  } finally {
    parent.kill("SIGKILL");
    if (supervisor) {
      try {
        process.kill(supervisor, "SIGTERM");
      } catch {
        /* Already cleaned up. */
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
