import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { checkpoint, DEFAULT_INTERVAL, humanMessages, intervalSchema, stateSchema, type State } from "./counting";
import { createRoutes, endpoint } from "./routes";
import { sourceContract, sourceId } from "./contracts";
import { z } from "zod";
import { createTitleService } from "./title-service";
import { createTitleContext, titleMessages } from "./title-context";

const PAGE_SIZE = 100;
const THREAD_PREFIX = "thread:";

export default function plugin(bb: BbPluginApi) {
  const pluginId = bb.pluginId;
  const settings = bb.settings.define({
    modelSource: { type: "string", label: "Model source ID", description: "Use the live picker below or run bb auto-title sources.", default: "automatic", experimental_schema: sourceId },
    customUrl: { type: "string", label: "Custom chat completions URL", default: "", experimental_schema: z.string().refine((value) => { try { return !value || !!endpoint(value); } catch { return false; } }, "Use HTTPS, or HTTP on localhost, without credentials, a query, or a fragment") },
    customModel: { type: "string", label: "Custom model", default: "" },
    customApiKey: { type: "string", label: "Custom API key", secret: true },
    interval: {
      type: "number",
      label: "Human messages per title check",
      default: DEFAULT_INTERVAL,
      experimental_schema: intervalSchema,
    },
  });
  const controller = new AbortController();
  const { signal } = controller;
  const pending = new Map<string, Promise<unknown>>();
  const kv = bb.storage.kv;
  const { threads } = bb.sdk;
  const routes = createRoutes(bb, () => settings.get());
  const titleService = createTitleService(bb, signal, routes.complete);
  bb.experimental_aiServices.register(titleService.declaration);

  async function observeTitle(current: Awaited<ReturnType<typeof threads.get>>, previous?: State["title"]) {
    if (previous && !previous.protected && current.title === previous.lastMachineTitle) return previous;
    if (current.title !== null && await titleService.wrote(current.title, Math.max(current.createdAt, previous?.protectedAt ?? 0), !previous?.protected && previous?.lastMachineTitle == null)) {
      bb.log.info(`Auto Title adopted service title for ${current.id}`);
      return { lastMachineTitle: current.title, protected: false };
    }
    if (previous?.protected) return previous;
    const protectedTitle = current.title !== null || previous?.lastMachineTitle != null;
    return {
      lastMachineTitle: previous?.lastMachineTitle ?? null,
      protected: protectedTitle,
      ...(protectedTitle ? { protectedAt: Date.now() } : {}),
    };
  }

  function serialize<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const task = (pending.get(threadId) ?? Promise.resolve()).catch(() => {}).then(() => {
      signal.throwIfAborted();
      return work();
    }).finally(() => {
      if (pending.get(threadId) === task) pending.delete(threadId);
    });
    pending.set(threadId, task);
    return task;
  }

  async function* requests(threadId: string, after: number, through?: number) {
    for (;;) {
      const rows = await threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        afterSeq: String(after),
        ...(through === undefined ? {} : { beforeSeq: String(through + 1) }),
        limit: String(PAGE_SIZE),
        order: "asc",
        signal,
      });
      signal.throwIfAborted();
      for (const row of rows) {
        if (row.seq <= after) continue;
        after = row.seq;
        yield row;
      }
      if (rows.length < PAGE_SIZE) return;
    }
  }

  async function checkTitle(threadId: string, state: State, force: boolean): Promise<string | null> {
    const key = THREAD_PREFIX + threadId;
    const current = await threads.get({ threadId, signal });
    if (!force) {
      const title = await observeTitle(current, state.title);
      if (title !== state.title) {
        state = { ...state, title };
        await kv.set(key, state);
      }
      if (title.protected) {
        bb.log.info(`Auto Title protected changed or unattributed title for ${threadId}: milestone ${state.milestone}`);
        return null;
      }
    }

    const context = createTitleContext();
    for await (const row of requests(threadId, 0, state.sequence)) {
      for (const text of titleMessages(row)) context.add(text);
    }
    const input = context.payload(current.title ?? current.titleFallback, force || current.title === null);
    if (!input) return null;
    const decision = await routes.complete(input, signal, current);
    if (decision.verdict === "keep") {
      bb.log.info(`Auto Title kept title for ${threadId}: milestone ${state.milestone}`);
      return null;
    }

    const latest = await threads.get({ threadId, signal });
    signal.throwIfAborted();
    if (latest.title !== current.title) {
      await kv.set(key, { ...state, title: { lastMachineTitle: state.title?.lastMachineTitle ?? null, protected: true, protectedAt: Date.now() } });
      bb.log.info(`Auto Title skipped changed title for ${threadId} while checking fit`);
      return null;
    }
    const title = decision.title === latest.title ? latest.title : (await threads.update({ threadId, title: decision.title })).title;
    await kv.set(key, { ...state, title: { lastMachineTitle: title, protected: false } });
    bb.log.info(`Auto Title accepted replacement for ${threadId}: milestone ${state.milestone}`);
    return title;
  }

  async function processThread(threadId: string, through?: number, force = false) {
    const key = THREAD_PREFIX + threadId;
    const value = await kv.get(key);
    const previous = value === undefined ? undefined : stateSchema.parse(value);
    const migrated = previous?.titlePolicy === 3;
    if (!force && migrated && through !== undefined && through <= previous.sequence) return null;
    const current = await threads.get({ threadId, signal });
    if (current.originPluginId === pluginId) return null;
    let sequence = previous?.sequence ?? 0;
    let count = previous?.count ?? 0;
    for await (const row of requests(threadId, sequence, through)) {
      count += humanMessages(row);
      sequence = row.seq;
    }
    sequence = Math.max(sequence, through ?? 0);
    const { interval } = await settings.get();
    const { state: counts, regenerate } = checkpoint(previous, sequence, count, interval);
    if (!force && migrated && previous.sequence === sequence && previous.interval === interval) return null;
    // Baseline old counters without replacing the current title. Unknown
    // nonempty titles on upgrade remain protected.
    const title = previous?.title ?? await observeTitle(current);
    const state = { ...counts, title, titlePolicy: 3 as const };
    signal.throwIfAborted();
    // Claim before checking fit so failed calls and reloads don't loop.
    await kv.set(key, state);
    if (!force && (!regenerate || !migrated)) return null;
    return checkTitle(threadId, state, force);
  }

  function catchUp(threadId: string, through?: number) {
    return serialize(threadId, () => processThread(threadId, through)).catch((error: unknown) => {
      if (!signal.aborted) bb.log.warn(`Auto Title kept title for ${threadId} after error: ${String(error)}`);
    });
  }

  async function listSources() {
    return routes.choices(AbortSignal.any([signal, AbortSignal.timeout(3000)]));
  }
  async function selectSource(source: string) {
    if (!(await listSources()).some(({ id }) => id === source)) throw new PluginCliError("Unknown model source; refresh the list of sources");
    await settings.experimental_set({ modelSource: source });
    return { selected: source };
  }
  bb.rpc.register(sourceContract, {
    "sources.list": async () => ({ selected: (await settings.get()).modelSource, choices: await listSources() }),
    "sources.set": ({ source }) => selectSource(source),
  });

  bb.cli.register(defineCli({
    name: "auto-title",
    summary: "Check and replace BB thread titles",
    commands: {
      sources: cliCommand({
        summary: "List available model sources and readiness",
        async run() {
          const { modelSource } = await settings.get();
          const choices = await listSources();
          return { exitCode: 0, stdout: choices.map(({ id, name, status }) => `${id === modelSource ? "*" : " "} ${id} — ${name}${status.ready ? "" : " (not ready)"}${"message" in status && status.message ? `: ${status.message}` : ""}`).join("\n") + "\n" };
        },
      }),
      source: cliCommand({
        summary: "Select a model source from the live list",
        positionals: [{ name: "source", description: "Source id from bb auto-title sources", required: true }],
        async run(input) {
          const modelSource = input.positionals.source;
          await selectSource(modelSource);
          return { exitCode: 0, stdout: `Model source: ${modelSource}\n` };
        },
      }),
      retitle: cliCommand({
        summary: "Replace a title from the thread's human messages and resume automatic checks",
        positionals: [{ name: "thread", description: "Thread id", required: true }],
        async run(input) {
          const threadId = input.positionals.thread;
          const title = await serialize(threadId, () => processThread(threadId, undefined, true));
          if (title === null) throw new PluginCliError("No replacement written; the existing title was kept");
          return { exitCode: 0, stdout: `${threadId}: ${title}\n` };
        },
      }),
    },
  }));
  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    if (thread.deletedAt == null && thread.originPluginId !== pluginId) return catchUp(thread.id, sequence).then(() => {});
  });
  bb.events.on("thread.deleted", ({ thread }) => serialize(thread.id, () => kv.delete(THREAD_PREFIX + thread.id)));
  bb.background.service("reconcile", {
    async start(startupSignal) {
      // Snapshot IDs before processing: retitling can reorder the list.
      const ids = new Set<string>();
      for (let offset = 0; !startupSignal.aborted; offset += PAGE_SIZE) {
        const page = await threads.list({ includeHidden: true, limit: PAGE_SIZE, offset, signal: startupSignal });
        for (const thread of page) if (thread.deletedAt == null && thread.originPluginId !== pluginId) ids.add(thread.id);
        if (page.length < PAGE_SIZE) break;
      }
      for (const id of ids) {
        if (startupSignal.aborted) return;
        await catchUp(id);
      }
      if (!startupSignal.aborted) bb.log.info(`Auto Title startup reconciliation complete: ${ids.size} threads`);
    },
  });
  bb.onDispose(() => { controller.abort(); });
}
