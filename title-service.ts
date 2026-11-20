import type { BbPluginApi, PluginAiServiceDeclaration } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { formatTitle } from "./format-title";
import type { createRoutes } from "./routes";

const CACHE_KEY = "service-titles:v1";
const MAX_RECEIPTS = 256;
const MAX_AGE = 7 * 24 * 60 * 60_000;
const HEADING = "You create concise titles for coding tasks.\n";
const receiptSchema = z.object({ title: z.string().max(48), at: z.number(), regenerate: z.boolean() });
const receiptsSchema = z.array(receiptSchema).max(MAX_RECEIPTS);
function deadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createTitleService(bb: BbPluginApi, lifetime: AbortSignal, complete: ReturnType<typeof createRoutes>["complete"]) {
  const kv = bb.storage.kv;
  let pending = Promise.resolve();
  async function receipts(now: number) {
    const stored = receiptsSchema.safeParse(await kv.get(CACHE_KEY));
    return stored.success ? stored.data.filter(({ at }) => at >= now - MAX_AGE && at <= now) : [];
  }

  async function remember(title: string, regenerate: boolean) {
    const write = pending.catch(() => {}).then(async () => {
      lifetime.throwIfAborted();
      const at = Date.now();
      const recent = await receipts(at);
      await kv.set(CACHE_KEY, [...recent, { title, at, regenerate }].slice(-MAX_RECEIPTS));
    });
    pending = write;
    await write;
  }

  const declaration: PluginAiServiceDeclaration = {
    id: "auto-title",
    displayName: "Auto Title",
    async complete(prompt, { signal }) {
      if (!prompt.startsWith(HEADING)) throw new Error("Auto Title only handles BB thread-title prompts");
      const body = prompt.split("\nTask:\n", 2)[1] ?? "";
      const titleLine = /\nThe thread is currently titled "([^\n]*)"\. If that title still describes the task as it stands,/.exec(prompt);
      const current = titleLine?.[1] ?? null;
      const task = body.split(/\n\n(?:Later messages from the user|The agent's latest replies|The thread is currently titled|Write the title)/u, 1)[0] ?? "";
      const later = /\nLater messages from the user[^\n]*:\n([\s\S]*?)(?:\n\n|$)/u.exec(body)?.[1];
      const messages = [task.slice(0, 4000), ...(later?.split("\n").slice(0, 8) ?? []).map((line) => line.slice(0, 600))];
      const active = AbortSignal.any([signal, lifetime, AbortSignal.timeout(3_800)]);
      let title: string;
      try {
        const decision = await deadline(complete(JSON.stringify({ title: current, force: true, messages }), active), active);
        title = decision.verdict === "replace" ? decision.title : "";
        if (!title) throw new Error("No valid replacement title");
        if (title === current) return title; // A same-text result provides no evidence of a write.
      } catch {
        signal.throwIfAborted();
        lifetime.throwIfAborted();
        if (current !== null) throw new Error("Auto Title could not regenerate the title; the current title was kept");
        title = formatTitle(task) || "New thread";
        bb.log.warn("Auto Title used task text as a fallback title");
      }
      try {
        await remember(title, current !== null);
      } catch {
        bb.log.warn("Auto Title could not remember a generated title; it will be treated as unattributed");
      }
      signal.throwIfAborted();
      lifetime.throwIfAborted();
      return title;
    },
  };
  return {
    declaration,
    async wrote(title: string, createdAt: number, allowFirst: boolean) {
      const recent = await receipts(Date.now());
      return recent.some((receipt) => receipt.title === title && receipt.at >= createdAt &&
        (receipt.regenerate || allowFirst));
    },
  };
}
