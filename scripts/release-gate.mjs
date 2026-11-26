import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const config = JSON.parse(readFileSync("docs/release.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(config.version))
  throw new Error("Invalid release version");
const tag = `v${config.version}`;
let published = false;
try {
  published = !JSON.parse(
    execFileSync("gh", ["release", "view", tag, "--json", "isDraft"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  ).isDraft;
} catch {
  /* 尚未发布 */
}
const ready = config.ready === true && !published;
appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nready=${ready}\n`);
console.log(
  ready
    ? `Final integrated release enabled: ${tag}`
    : "No final release requested",
);
