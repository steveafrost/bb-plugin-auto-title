import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseDecision, SYSTEM } from "./model";

const CHAT = "chat.complete";
const MODELS = "models.list";
const CLOUD_PLUGIN = "bb-ai";
const COMPLETION = z.object({ text: z.string() });
const CATALOG = z.object({ models: z.array(z.object({ id: z.string().min(1), deprecated: z.boolean().optional(), reasoning: z.object({ supported: z.boolean(), canDisable: z.boolean() }).optional() })) });
export const helperTitle = "Auto Title helper";
export type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
export type ModelSettings = { modelSource: string; customUrl: string; customModel: string; customApiKey?: string };

export function endpoint(value: string): URL {
  try {
    const url = new URL(value.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error();
    return url;
  } catch { throw new Error("Enter an HTTPS chat completions URL (HTTP is allowed only on localhost) without credentials, query, or fragment"); }
}

export async function customCompletion(config: ModelSettings, prompt: string, signal: AbortSignal, fetcher = fetch) {
  const url = endpoint(config.customUrl);
  if (!config.customModel.trim()) throw new Error("Custom model is not configured");
  try {
    const response = await fetcher(url, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", ...(config.customApiKey ? { authorization: `Bearer ${config.customApiKey}` } : {}) },
      body: JSON.stringify({ model: config.customModel.trim(), messages: [{ role: "user", content: prompt }], max_tokens: 384 }),
    });
    if (!response.ok) throw new Error();
    const result = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }).parse(await response.json());
    return result.choices[0]!.message.content;
  } catch { throw new Error("Custom completion failed"); }
}

async function bounded<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(fn).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createRoutes(bb: BbPluginApi, config: () => Promise<ModelSettings>) {
  const { plugins, system, threads, providers, environments } = bb.sdk;
  const pluginId = bb.pluginId;
  async function inventory(signal: AbortSignal) {
    const [view, methods] = await Promise.all([
      bounded(signal, () => system.aiServices({ signal })).catch(() => null),
      bounded(signal, () => plugins.experimental_discoverRpc()).catch(() => []),
    ]);
    const all = view?.services ?? [];
    const cloud = all.find((service) => service.pluginId === CLOUD_PLUGIN && service.tasks.includes("thread-title"));
    const available = methods.filter((method) => method.method === CHAT && method.pluginId !== pluginId && method.pluginId !== CLOUD_PLUGIN &&
      methods.some((other) => other.pluginId === method.pluginId && other.method === MODELS));
    const discovered = available.map((method) => {
      const services = all.filter((service) => service.pluginId === method.pluginId && service.tasks.includes("thread-title"));
      const ready = services.find((service) => service.status.ready);
      const status = ready?.status ?? services[0]?.status ?? { ready: true as const };
      return { id: `plugin:${method.pluginId}`, pluginId: method.pluginId, name: method.displayName,
        status, rank: ready?.automaticRank ?? Number.MAX_SAFE_INTEGER };
    }).sort((a, b) => a.rank - b.rank || a.pluginId.localeCompare(b.pluginId));
    return { cloud, discovered };
  }

  async function helper(thread: Thread, prompt: string, signal: AbortSignal, explicit: boolean) {
    const hostId = thread.environmentId ? (await environments.get({ environmentId: thread.environmentId, signal })).hostId : null;
    if (!hostId) throw new Error("No host available for an isolated provider helper");
    const [catalog, available] = await Promise.all([
      providers.models({ hostId, providerId: thread.providerId, signal }),
      providers.list({ hostId, signal }),
    ]);
    const modes = available.find((provider) => provider.id === thread.providerId && provider.available)?.capabilities.permissionModes ?? [];
    const permissionMode = modes.includes("auto") ? "auto" : explicit && modes.includes("accept-edits") ? "accept-edits" : explicit && modes.includes("full") ? "full" : null;
    if (!permissionMode) throw new Error("Provider does not offer an automatic helper permission mode");
    const candidates = catalog.models.filter((model) => /(?:^|[-./])(?:haiku|mini|flash|nano|small)(?:[-./]|$)/i.test(model.id));
    const small = candidates.find((model) => model.supportedReasoningEfforts?.some((effort) => effort.reasoningEffort === "none")) ?? candidates[0];
    if (!small) throw new Error("No small model available on the thread provider");
    signal.throwIfAborted();
    // No workspace or parent notifications; the explicit title bypasses BB's title service.
    const child = await threads.spawn({ projectId: thread.projectId, environment: { type: "host", hostId, workspace: { type: "unmanaged", path: null } },
      providerId: thread.providerId, model: small.id, reasoningLevel: small.supportedReasoningEfforts?.some((effort) => effort.reasoningEffort === "none") ? "none" : "low", permissionMode, origin: "plugin", originPluginId: pluginId,
      visibility: "hidden", title: helperTitle, parentNotifications: "off", pluginMetadata: { helper: true },
      ...(thread.archivedAt === null ? { lifecycleOwnerThreadId: thread.id } : {}), prompt: `Do not call any tools. Reply only with the title verdict.\n\n${prompt}` }).catch((error: unknown) => {
      const code = z.object({ status: z.number() }).safeParse(error);
      bb.log.warn(`Auto Title provider helper could not start${code.success ? ` (HTTP ${code.data.status})` : ""}`);
      throw new Error("Provider helper could not start");
    });
    bb.log.info(`Auto Title started hidden provider helper ${child.id}`);
    try {
      for (;;) {
        signal.throwIfAborted();
        const current = await threads.get({ threadId: child.id, signal });
        if (current.status === "error" || current.deletedAt !== null) throw new Error("Helper did not complete");
        if (current.status === "idle") {
          const result = await threads.output({ threadId: child.id, signal });
          return result.output ?? "";
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } finally {
      await threads.stop({ threadId: child.id }).catch(() => {});
      try {
        await threads.delete({ threadId: child.id, childThreadsConfirmed: true });
        bb.log.info(`Auto Title removed provider helper ${child.id}`);
      } catch { bb.log.warn(`Auto Title could not remove provider helper ${child.id}`); }
    }
  }

  async function choices(signal: AbortSignal) {
    const [{ cloud, discovered }, settings] = await Promise.all([inventory(signal), config()]);
    return [
      { id: "automatic", name: "Automatic", status: { ready: true } },
      { id: "custom", name: "Custom endpoint", status: { ready: configured(settings) } },
      { id: "cloud", name: "BB Cloud", status: cloud?.status ?? { ready: false, message: "Not available" } },
      ...discovered,
      { id: "provider", name: "Thread provider", status: { ready: true, message: "Milestones and CLI retitles only; provider permissions apply" } },
    ];
  }

  function configured(settings: ModelSettings) {
    try { return !!settings.customModel.trim() && !!endpoint(settings.customUrl); } catch { return false; }
  }

  async function complete(input: string, callerSignal: AbortSignal, thread?: Thread) {
    const signal = thread ? AbortSignal.any([callerSignal, AbortSignal.timeout(60_000)]) : callerSignal;
    const settings = await config();
    const source = settings.modelSource;
    const auto = source === "automatic";
    const prompt = `${SYSTEM}\n\nUntrusted thread data (JSON):\n${input}`;
    async function attempt(call: (budget: AbortSignal) => Promise<string>, timeout: number) {
      const budget = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
      try {
        const raw = await bounded(budget, () => call(budget));
        const decision = parseDecision(raw);
        if (decision.verdict === "keep" && JSON.parse(input).force) throw new Error("Expected replacement");
        return decision;
      } catch { signal.throwIfAborted(); return null; }
    }
    if ((auto || source === "custom") && configured(settings)) {
      const decision = await attempt((budget) => customCompletion(settings, prompt, budget), thread ? 8_000 : auto ? 1_200 : 3_300);
      if (decision) return decision;
    }
    if (auto || source === "cloud" || source.startsWith("plugin:")) {
      const { cloud, discovered } = await inventory(AbortSignal.any([signal, AbortSignal.timeout(thread ? 3_000 : 800)]));
      if ((auto || source === "cloud") && cloud?.status.ready) {
        const decision = await attempt(async (budget) => {
          const result = await plugins.callRpc({ pluginId: "bb-account", method: "bb-account.v1.fetch", signal: budget,
            input: { target: "api", method: "POST", path: "/api/ai/v1/complete", body: { prompt }, timeoutMs: 4500 },
            outputSchema: z.object({ status: z.number(), body: z.unknown() }) });
          if (result.status !== 200) throw new Error("Cloud completion failed");
          return COMPLETION.parse(result.body).text;
        }, thread ? 5_000 : auto ? 1_500 : 3_300);
        if (decision) return decision;
      }
      for (const route of discovered) {
        if (!(auto || source === route.id) || !route.status.ready) continue;
        const decision = await attempt(async (budget) => {
          const list = await plugins.callRpc({ pluginId: route.pluginId, method: MODELS, input: { scope: "fast_chat" }, outputSchema: CATALOG, signal: budget });
          const model = list.models.find((m) => !m.deprecated && (!m.reasoning?.supported || m.reasoning.canDisable)) ?? list.models.find((m) => !m.deprecated);
          if (!model) throw new Error("No fast chat model");
          const result = await plugins.callRpc({ pluginId: route.pluginId, method: CHAT, signal: budget,
            input: { model: model.id, scope: "fast_chat", prompt, maxTokens: 384, ...(model.reasoning?.canDisable ? { reasoningEffort: "none" } : {}), timeoutMs: 8000 }, outputSchema: COMPLETION });
          return result.text;
        }, thread ? 9_000 : 3_300);
        if (decision) return decision;
      }
    }
    if (thread && (auto || source === "provider")) {
      const decision = await attempt((budget) => helper(thread, prompt, budget, !auto), 30_000);
      if (decision) return decision;
    }
    throw new Error("No title model returned a usable verdict");
  }
  return { complete, choices };
}
