import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export async function desktopSSHFixture(directory) {
  const require = createRequire(resolve("apps/desktop/package.json"));
  const { Server } = require("ssh2");
  const key = join(directory, "ssh-fixture-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-f", key, "-N", ""]);
  const publicKey = readFileSync(key + ".pub", "utf8").split(" ")[1];
  const fingerprint =
    "SHA256:" +
    createHash("sha256")
      .update(Buffer.from(publicKey, "base64"))
      .digest("base64")
      .replace(/=+$/, "");
  const clients = new Set();
  let shells = 0;
  const password = "desktop-test-password";
  const server = new Server({ hostKeys: [readFileSync(key)] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (auth) =>
      (auth.method === "password" && auth.password === password) ||
      (auth.method === "publickey" && auth.key?.data)
        ? auth.accept()
        : auth.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => accept());
        session.on("window-change", (accept) => accept?.());
        session.on("shell", (accept) => {
          shells++;
          const stream = accept();
          stream.write("Gungun theme test terminal ready\r\n");
          stream.on("data", (chunk) =>
            stream.write("received:" + chunk.toString()),
          );
        });
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    password,
    fingerprint,
    get shells() {
      return shells;
    },
    async close() {
      for (const client of clients) client.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
