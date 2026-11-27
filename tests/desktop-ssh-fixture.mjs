import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

function executeFixtureCommand(command, authorizedKeysPath) {
  const installPrefix =
    "umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -Fqx -- ";
  if (command.startsWith(installPrefix)) {
    if (
      !command.includes(" || printf '%s") ||
      !command.endsWith(" >> ~/.ssh/authorized_keys")
    ) {
      throw new Error("Unexpected SSH authorized_keys command shape");
    }
    const keys = [
      ...command.matchAll(
        /'((?:ssh-ed25519|ssh-rsa|ecdsa-sha2-[A-Za-z0-9-]+) [A-Za-z0-9+/=]+)'/g,
      ),
    ].map((match) => match[1]);
    if (keys.length !== 2 || keys[0] !== keys[1]) {
      throw new Error("SSH authorized_keys command did not use one consistent public key");
    }

    mkdirSync(dirname(authorizedKeysPath), { recursive: true, mode: 0o700 });
    const existing = existsSync(authorizedKeysPath)
      ? readFileSync(authorizedKeysPath, "utf8")
      : "";
    if (!existing.split(/\r?\n/).includes(keys[0])) {
      const separator = existing && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(
        authorizedKeysPath,
        `${existing}${separator}${keys[0]}\n`,
        { mode: 0o600 },
      );
    }
    return "";
  }

  if (
    command ===
    "uname -sm; if command -v tailscale >/dev/null; then tailscale status --json; fi"
  ) {
    return "Linux x86_64\n";
  }

  throw new Error(`Unsupported command in SSH fixture: ${command}`);
}

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
  const authorizedKeysPath = join(directory, "remote-home", ".ssh", "authorized_keys");
  let shells = 0;
  let passwordLogins = 0;
  let publicKeyLogins = 0;
  const password = "desktop-test-password";
  const server = new Server({ hostKeys: [readFileSync(key)] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (auth) => {
      if (auth.method === "password" && auth.password === password) {
        passwordLogins++;
        auth.accept();
        return;
      }

      if (auth.method === "publickey" && auth.key?.data) {
        const candidate = Buffer.from(auth.key.data);
        const authorized = existsSync(authorizedKeysPath)
          ? readFileSync(authorizedKeysPath, "utf8")
              .split(/\r?\n/)
              .some((line) => {
                const [, encoded] = line.trim().split(/\s+/);
                return (
                  encoded &&
                  Buffer.from(encoded, "base64").equals(candidate)
                );
              })
          : false;
        if (authorized) {
          publicKeyLogins++;
          auth.accept();
          return;
        }
      }

      auth.reject();
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => accept());
        session.on("window-change", (accept) => accept?.());
        session.on("exec", (accept, _reject, info) => {
          const stream = accept();
          try {
            const output = executeFixtureCommand(info.command, authorizedKeysPath);
            if (output) stream.write(output);
            stream.exit(0);
          } catch (error) {
            stream.stderr.write(String(error));
            stream.exit(1);
          }
          stream.end();
        });
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
    get passwordLogins() {
      return passwordLogins;
    },
    get publicKeyLogins() {
      return publicKeyLogins;
    },
    get authorizedKeys() {
      return existsSync(authorizedKeysPath)
        ? readFileSync(authorizedKeysPath, "utf8")
        : "";
    },
    async close() {
      for (const client of clients) client.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
