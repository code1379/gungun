/* eslint @typescript-eslint/no-require-imports: "off" */
module.exports = async ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== "darwin" || !process.env.APPLE_ID) return;
  for (const name of ["APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"])
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  const { execFileSync } = require("node:child_process");
  const app = `${appOutDir}/${packager.appInfo.productFilename}.app`;
  const zip = `${appOutDir}/notarize.zip`;
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
  execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      zip,
      "--apple-id",
      process.env.APPLE_ID,
      "--password",
      process.env.APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id",
      process.env.APPLE_TEAM_ID,
      "--wait",
    ],
    { stdio: "inherit" },
  );
  execFileSync("xcrun", ["stapler", "staple", app], { stdio: "inherit" });
  require("node:fs").unlinkSync(zip);
};
