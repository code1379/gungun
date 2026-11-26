import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
if (process.platform !== "darwin")
  throw new Error("DMG verification requires real macOS");
const files = (await readdir("release")).filter((f) => f.endsWith(".dmg"));
if (files.length !== 1)
  throw new Error(`Expected one DMG, found ${files.length}`);
const directory = await mkdtemp(join(tmpdir(), "gungun-dmg-"));
const mount = join(directory, "mount");
await mkdir(mount);
try {
  execFileSync(
    "hdiutil",
    [
      "attach",
      resolve("release", files[0]),
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mount,
    ],
    { stdio: "inherit" },
  );
  const installed = join(directory, "installed", "Gungun.app");
  await mkdir(join(directory, "installed"));
  execFileSync("ditto", [join(mount, "Gungun.app"), installed]);
  execFileSync(process.execPath, ["tests/desktop-smoke.mjs"], {
    env: {
      ...process.env,
      PACKAGED_APP: join(installed, "Contents/MacOS/Gungun"),
    },
    stdio: "inherit",
  });
  console.log(`Verified actual DMG install and launch: ${files[0]}`);
} finally {
  try {
    execFileSync("hdiutil", ["detach", mount], { stdio: "inherit" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
