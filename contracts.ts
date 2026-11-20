import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const sourceId = z.string().regex(/^(?:automatic|custom|cloud|provider|plugin:[a-z0-9_-]+)$/);
export const sourceContract = defineRpcContract({
  "sources.list": {
    input: z.null(),

    output: z.object({ selected: z.string(), choices: z.array(z.object({ id: z.string(), name: z.string(), status: z.object({ ready: z.boolean(), message: z.string().optional() }) })) }),
  },
  "sources.set": { input: z.object({ source: sourceId }), output: z.object({ selected: z.string() }) },
});
