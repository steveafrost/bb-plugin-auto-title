import { z } from "zod";

export const DEFAULT_INTERVAL = 10;
export const intervalSchema = z.number().int().positive();
const nonnegative = z.number().int().nonnegative();
export const stateSchema = z.object({
  sequence: nonnegative,
  count: nonnegative,
  milestone: nonnegative,
  interval: intervalSchema,
  titlePolicy: z.literal(3).optional(),
  title: z.object({
    lastMachineTitle: z.string().nullable(),
    protected: z.boolean(),
    protectedAt: nonnegative.optional(),
  }).optional(),
});
export type State = z.infer<typeof stateSchema>;

const requestSchema = z.object({
  initiator: z.literal("user"),
  senderThreadId: z.null().optional(),
  originPluginId: z.null().optional(),
  retryOfRequestId: z.undefined().optional(),
  retryAttempt: z.undefined().optional(),
  systemMessageKind: z.literal("unlabeled").optional(),
  inputGroups: z.array(z.array(z.unknown()).min(1)).min(1).optional(),
});

export function humanMessages(row: { type: string; data: unknown }): number {
  if (row.type !== "client/turn/requested") return 0;
  const result = requestSchema.safeParse(row.data);
  return result.success ? (result.data.inputGroups?.length ?? 1) : 0;
}

export function checkpoint(previous: State | undefined, sequence: number, count: number, interval: number) {
  const milestone = Math.floor(count / interval);
  // On a settings change, apply the new interval to new messages only.
  const handled = previous?.interval === interval ? previous.milestone : Math.floor((previous?.count ?? count) / interval);
  return { state: { sequence, count, interval, milestone }, regenerate: milestone > handled };
}
