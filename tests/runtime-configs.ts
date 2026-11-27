import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { nodeSchema, singboxConfig } from "../packages/domain/src/index";

const requests = z.array(z.object({ nodes: z.array(nodeSchema), nodeIds: z.array(z.string()).optional() })).parse(JSON.parse(readFileSync(0, "utf8")));
process.stdout.write(JSON.stringify(requests.map(({ nodes, nodeIds }) => {
  const config = singboxConfig(nodes, nodeIds ? { id: randomUUID(), name: "Runtime integration chain", nodeIds } : undefined, 0);
  config.log.level = "debug";
  return config;
})));
