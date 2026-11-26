import { execFileSync } from "node:child_process";
const tag = process.env.RELEASE_TAG,
  source = process.env.RELEASE_SOURCE;
if (
  !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag || "") ||
  !/^[a-f0-9]{40}$/.test(source || "")
)
  throw new Error("Invalid release tag or source");
let draft;
try {
  draft = JSON.parse(
    execFileSync("gh", ["release", "view", tag, "--json", "isDraft,tagName"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
} catch {
  execFileSync(
    "gh",
    [
      "release",
      "create",
      tag,
      "--draft",
      "--target",
      source,
      "--title",
      `Gungun ${tag}`,
      "--notes",
      `Awaiting all platform verification. Source: ${source}`,
    ],
    { stdio: "inherit" },
  );
  draft = { isDraft: true };
}
if (!draft.isDraft) throw new Error("Refusing to modify a published release");
