import { describe, expect, it } from "vitest";
import { parseCurlLatencySamples } from "../apps/desktop/src/main/benchmark";

describe("curl real-delay output parser", () => {
  it("parses two successful HTTP samples separated by newlines", () => {
    expect(parseCurlLatencySamples("204 0.120\\n204 0.040\\n")).toEqual([120, 40]);
  });

  it("supports CRLF and ignores invalid or unsuccessful responses", () => {
    expect(
      parseCurlLatencySamples("500 0.900\\r\\n204 0.075\\r\\ninvalid\\r\\n"),
    ).toEqual([75]);
  });

  it("returns no samples for empty output", () => {
    expect(parseCurlLatencySamples("")).toEqual([]);
  });
});
