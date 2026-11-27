import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  parseCurlLatencySamples,
  probeTcpEndpoint,
} from "../apps/desktop/src/main/benchmark";

describe("curl real-delay output parser", () => {
  it("parses two successful HTTP samples separated by newlines", () => {
    expect(parseCurlLatencySamples("204 0.120\n204 0.040\n")).toEqual([120, 40]);
  });

  it("supports CRLF and ignores invalid or unsuccessful responses", () => {
    expect(
      parseCurlLatencySamples("500 0.900\r\n204 0.075\r\ninvalid\r\n"),
    ).toEqual([75]);
  });

  it("returns no samples for empty output", () => {
    expect(parseCurlLatencySamples("")).toEqual([]);
  });
});


describe("Snell TCP preflight", () => {
  it("accepts a reachable TCP listener", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    try {
      await expect(probeTcpEndpoint("127.0.0.1", address.port)).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it("reports a closed TCP port", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await expect(probeTcpEndpoint("127.0.0.1", port, 1000)).rejects.toThrow();
  });
});
