import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, mkdir, readFile } from "node:fs/promises";
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
  const binaries = join(installed, "Contents", "Resources", "bin");
  execFileSync(join(binaries, `sing-box-darwin-${process.arch === "x64" ? "amd64" : process.arch}`), ["version"], { stdio: "inherit" });
  for (const [arch, machine] of [["amd64", 62], ["arm64", 183]]) {
    const binary = await readFile(join(binaries, `fq-linux-${arch}`));
    if (binary.length < 100000 || !binary.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) || binary.readUInt16LE(18) !== machine)
      throw new Error(`Invalid bundled fq Linux ${arch} executable`);
  }
  console.log("Verified bundled native sing-box and both fq ELF architectures.");

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

