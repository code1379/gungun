import { readFileSync, writeFileSync } from "node:fs";
const version = process.env.RELEASE_VERSION?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
  throw new Error("Invalid version tag");
for (const path of ["package.json", "apps/desktop/package.json"]) {
  const data = JSON.parse(readFileSync(path));
  data.version = version;
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}
