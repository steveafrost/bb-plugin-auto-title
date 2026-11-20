import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { humanMessages } from "../counting";
import { parseDecision } from "../model";
import { createRoutes } from "../routes";
import { createTitleContext, titleMessages } from "../title-context";

vi.mock("../routes", async (importOriginal) => ({
  ...await importOriginal<typeof import("../routes")>(), createRoutes: vi.fn(),
}));
const completion = vi.fn<(input: string) => Promise<string>>();
vi.mocked(createRoutes).mockReturnValue({
  complete: async (input) => parseDecision(await completion(input)),
  choices: async () => [],
});
const replacement = JSON.stringify({ verdict: "replace", title: "Check the title" });
afterEach(() => completion.mockReset());

const thread = makeThreadResponse({ id: "test-thread" });
const key = `thread:${thread.id}`;
const request = (seq: number, data: Record<string, unknown> = {}) => ({
  seq,
  type: "client/turn/requested",
  data: { initiator: "user", senderThreadId: null, requestId: `creq_${seq}`, input: [{ type: "text", text: `Message ${seq}` }], ...data },
});
const requests = (count: number, from = 1) => Array.from({ length: count }, (_, i) => request(from + i));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

async function fixture(initial: ReturnType<typeof request>[] = [], initialTitle: string | null = null) {
  const rows = [...initial];
  completion.mockResolvedValue(replacement);
  let current = { ...thread, title: initialTitle };
  const update = vi.fn(async ({ title }: { title?: string | null }) => {
    current = { ...current, title: title ?? null };
    return current;
  });
  const eventList = vi.fn(async (args: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0]) =>
    rows.filter((r) => r.seq > Number(args.afterSeq) &&
      (args.beforeSeq === undefined || r.seq < Number(args.beforeSeq)) && args.types?.some((type) => type === r.type))
      .slice(0, Number(args.limit)));
  let host = createFakePluginHost({
    pluginId: "auto-title",
    sdk: { threads: { list: async () => [thread], events: { list: eventList }, get: async () => current, update } },
  });
  plugin(host.bb);
  cleanup.push(() => host.harness.lifecycle.dispose());
  return {
    rows, update, eventList,
    service(currentTitle?: string) {
      const prompt = "You create concise titles for coding tasks.\n\nTask:\nPlan a garden irrigation schedule.\n\n" +
        (currentTitle === undefined ? "" : `The thread is currently titled "${currentTitle}". If that title still describes the task as it stands, reply with it unchanged.\n\n`) +
        "Write the title in the language of the task.";
      return host.harness.registrations.aiServiceRegistrations[0]!.complete!(prompt, { signal: new AbortController().signal });
    },
    setOrigin(originPluginId: string) { current = { ...current, originPluginId }; },
    rename(title: string) { current = { ...current, title }; },
    retitle: () => host.harness.behavior.runCli(["retitle", thread.id]),
    get bb() { return host.bb; },
    get harness() { return host.harness; },
    async reload() { host = await host.harness.lifecycle.reload(plugin); },
    emit: (sequence: number) => host.harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence }),
    reconcile: () => host.harness.behavior.runService("reconcile").done,
  };
}

describe("Auto Title", () => {
  it("does not count hidden helper events or allow an explicit retitle on a helper", async () => {
    const f = await fixture(requests(10));
    f.setOrigin("auto-title");
    await f.emit(10);
    await f.reconcile();
    expect((await f.retitle()).exitCode).not.toBe(0);
    expect(f.eventList).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();
    expect(await f.bb.storage.kv.get(key)).toBeUndefined();
  });

  it("keeps 0.3 settings and title records while defaulting the new source to Automatic", async () => {
    const f = await fixture(requests(9), "Known title");
    await f.harness.behavior.setSettings({ interval: 12 });
    const record = { sequence: 9, count: 9, interval: 12, milestone: 0, titlePolicy: 3, title: { lastMachineTitle: "Known title", protected: false } };
    await f.bb.storage.kv.set(key, record);
    await f.reload();
    expect((await f.harness.behavior.callRpc("sources.list", null))).toMatchObject({ selected: "automatic" });
    await f.reconcile();
    expect(await f.bb.storage.kv.get(key)).toEqual(record);
    expect(f.update).not.toHaveBeenCalled();
  });

  it("counts a steer request, not its acceptance, and excludes retries and other authors", () => {
    const steer = request(1, { target: { kind: "steer", expectedTurnId: "turn_1" } });
    expect(humanMessages(steer)).toBe(1);
    expect(humanMessages({ type: "turn/input/accepted", data: { clientRequestId: steer.data.requestId } })).toBe(0);
    for (const data of [
      { initiator: "agent" }, { initiator: "system" },
      { senderThreadId: "test-agent" }, { originPluginId: "automations" },
      { retryOfRequestId: "creq_1", retryAttempt: 2 },
    ]) expect(humanMessages(request(2, data))).toBe(0);
    expect(humanMessages(request(3, { inputGroups: [[{}], [{}]] }))).toBe(2);
  });

  it("baselines multipage existing history and serializes overlapping notifications", async () => {
    const f = await fixture(requests(109));
    await f.reconcile();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.eventList).toHaveBeenCalledTimes(2);
    f.rows.push(request(110, { target: { kind: "steer" } }), request(111, { retryOfRequestId: "creq_110" }));
    await Promise.all([f.emit(111), f.emit(110), f.emit(111)]);
    expect(f.update).toHaveBeenCalledExactlyOnceWith({ threadId: thread.id, title: "Check the title" });
    expect(await f.bb.storage.kv.get(key)).toEqual({ sequence: 111, count: 110, milestone: 11, interval: 10, titlePolicy: 3, title: { lastMachineTitle: "Check the title", protected: false } });
  });

  it("reconciles missed pushes after reload, with one refresh for a multi-bucket gap", async () => {
    const f = await fixture(requests(9));
    await f.emit(9);
    f.rows.push(...requests(13, 10));
    await f.reload();
    await f.reconcile();
    await f.emit(23);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.eventList.mock.calls[1]?.[0].afterSeq).toBe("9");
  });

  it("logs a failure without looping, including after reload, and tries the next crossing", async () => {
    const f = await fixture(requests(9));
    await f.reconcile();
    completion.mockRejectedValueOnce(new Error("title service unavailable"));
    f.rows.push(request(10));
    await f.emit(10);
    expect(JSON.stringify(f.harness.logEntries)).toContain("title service unavailable");
    await f.reload();
    await f.reconcile();
    await f.emit(11);
    expect(f.update).not.toHaveBeenCalled();
    expect(completion).toHaveBeenCalledTimes(1);
    f.rows.push(...requests(10, 12));
    await f.emit(21);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it("rebases when the interval changes, without retitling an existing thread", async () => {
    const f = await fixture(requests(9));
    await f.reconcile();
    await f.harness.behavior.setSettings({ interval: 5 });
    await f.emit(9);
    expect(f.update).not.toHaveBeenCalled();
    f.rows.push(request(11));
    await f.emit(11);
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it("rebases a missed milestone on upgrade from 0.2 even for a known title", async () => {
    const f = await fixture(requests(10), "Old machine title");
    await f.bb.storage.kv.set(key, { sequence: 9, count: 9, interval: 10, milestone: 0,
      title: { lastMachineTitle: "Old machine title", protected: false } });
    await f.reconcile();
    expect(completion).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(await f.bb.storage.kv.get(key)).toMatchObject({ titlePolicy: 3, milestone: 1 });
  });

  it("adopts a service-generated first title after reload and replaces it on drift", async () => {
    const f = await fixture(requests(9));
    await f.reconcile();
    f.rename(await f.service());
    await f.reload();
    f.rows.push(request(10));
    completion.mockResolvedValueOnce('{"verdict":"replace","title":"Solar charging system"}');
    await f.emit(10);
    expect(f.update).toHaveBeenCalledExactlyOnceWith({ threadId: thread.id, title: "Solar charging system" });
    expect(JSON.parse(completion.mock.lastCall![0])).toMatchObject({ title: "Check the title", force: false });
  });

  it("keeps a hand rename after a service title and resumes after built-in regeneration", async () => {
    const f = await fixture(requests(9));
    f.rename(await f.service());
    await f.reconcile();
    f.rename("A hand title");
    f.rows.push(request(10));
    await f.emit(10);
    expect(f.update).not.toHaveBeenCalled();
    expect(await f.bb.storage.kv.get(key)).toMatchObject({ title: { lastMachineTitle: "Check the title", protected: true } });
    completion.mockResolvedValueOnce('{"verdict":"replace","title":"Solar charging system"}');
    f.rename(await f.service("A hand title"));
    f.rows.push(...requests(10, 11));
    completion.mockResolvedValueOnce('{"verdict":"keep","title":null}');
    await f.emit(20);
    expect(await f.bb.storage.kv.get(key)).toMatchObject({ title: { lastMachineTitle: "Solar charging system", protected: false } });
    expect(JSON.parse(completion.mock.lastCall![0])).toMatchObject({ title: "Solar charging system", force: false });
  });

  it("falls back to task text on first-title service failure but keeps an existing title", async () => {
    const f = await fixture(requests(9));
    completion.mockRejectedValue(new Error("proxy unreachable"));
    expect(await f.service()).toBe("Plan a garden irrigation schedule");
    await expect(f.service("A hand title")).rejects.toThrow("the current title was kept");
    expect(await f.bb.storage.kv.get("service-titles:v1")).toEqual([
      { title: "Plan a garden irrigation schedule", at: expect.any(Number), regenerate: false },
    ]);
  });

  it("does not adopt expired receipts or a first-title receipt for a protected thread", async () => {
    const f = await fixture(requests(9), "Initial hand title");
    await f.reconcile();
    f.rename(await f.service());
    f.rows.push(request(10));
    await f.emit(10);
    expect(await f.bb.storage.kv.get(key)).toMatchObject({ title: { lastMachineTitle: null, protected: true } });
    await f.bb.storage.kv.set("service-titles:v1", [{ title: "Old service title", at: Date.now() - 8 * 86400_000, regenerate: true }]);
    f.rename("Old service title");
    f.rows.push(...requests(10, 11));
    await f.emit(20);
    expect(await f.bb.storage.kv.get(key)).toMatchObject({ title: { lastMachineTitle: null, protected: true } });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("keeps a fitting title, then replaces it when a later milestone no longer fits", async () => {
    const f = await fixture(requests(9), "Initial title");
    expect((await f.retitle()).exitCode).toBe(0);
    f.update.mockClear();
    completion.mockResolvedValueOnce('{"verdict":"keep","title":null}');
    f.rows.push(request(10));
    await f.emit(10);
    expect(f.update).not.toHaveBeenCalled();
    expect(JSON.parse(completion.mock.lastCall![0])).toMatchObject({ title: "Check the title", force: false, totalMessages: 10 });
    completion.mockResolvedValueOnce('{"verdict":"replace","title":"A different goal"}');
    f.rows.push(...requests(10, 11));
    await f.emit(20);
    expect(f.update).toHaveBeenCalledExactlyOnceWith({ threadId: thread.id, title: "A different goal" });
  });

  it("protects a changed title persistently until an explicit successful retitle", async () => {
    const f = await fixture(requests(9));
    await f.retitle();
    f.rename("Written by Steve");
    f.rows.push(request(10));
    await f.emit(10);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(await f.bb.storage.kv.get(key)).toMatchObject({ title: { lastMachineTitle: "Check the title", protected: true } });
    f.rename("Check the title");
    f.rows.push(...requests(10, 11));
    await f.emit(20);
    expect(completion).toHaveBeenCalledTimes(1);
    f.rename("Another handwritten title");
    expect((await f.retitle()).exitCode).toBe(0);
    expect(await f.bb.storage.kv.get(key)).toMatchObject({ title: { lastMachineTitle: "Check the title", protected: false } });
  });

  it("re-reads the title after the model call and respects a concurrent user rename", async () => {
    const f = await fixture(requests(9));
    await f.reconcile();
    completion.mockImplementationOnce(async () => { f.rename("Changed during inference"); return replacement; });
    f.rows.push(request(10));
    await f.emit(10);
    expect(f.update).not.toHaveBeenCalled();
    expect(await f.bb.storage.kv.get(key)).toMatchObject({ title: { protected: true } });
  });

  it("upgrades 0.1.0 counts across a missed milestone without changing the title", async () => {
    const f = await fixture(requests(11), "Unattributed title");
    await f.bb.storage.kv.set(key, { sequence: 9, count: 9, milestone: 0, interval: 10 });
    await f.reconcile();
    expect(await f.bb.storage.kv.get(key)).toEqual({ sequence: 11, count: 11, milestone: 1, interval: 10, titlePolicy: 3, title: { lastMachineTitle: null, protected: true, protectedAt: expect.any(Number) } });
    expect(completion).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it("fails closed on free-form or invalid model replies", async () => {
    const f = await fixture(requests(9));
    await f.reconcile();
    completion.mockResolvedValueOnce("a replacement, probably");
    f.rows.push(request(10));
    await f.emit(10);
    expect(f.update).not.toHaveBeenCalled();
    expect(JSON.stringify(f.harness.logEntries)).toContain("Invalid title verdict");
  });

  it("bounds the context while retaining the opening, middle and recent messages", () => {
    const context = createTitleContext();
    for (const row of requests(1000)) for (const text of titleMessages(row)) context.add(text);
    const payload = JSON.parse(context.payload("Title", false)!);
    const indexes = payload.messages.map((message: { message: number }) => message.message);
    expect(indexes).toHaveLength(new Set(indexes).size);
    expect(indexes.length).toBeLessThanOrEqual(32);
    expect(indexes[0]).toBe(1);
    expect(indexes.slice(-12)).toEqual(Array.from({ length: 12 }, (_, i) => 989 + i));
    expect(indexes.some((index: number) => index > 400 && index < 600)).toBe(true);
    expect(titleMessages(request(1, { input: [
      { type: "text", text: "private", visibility: "agent-only" },
      { type: "text", text: "a".repeat(2000) },
    ] }))).toEqual(["a".repeat(320)]);
  });

  it("only imports public SDK modules", async () => {
    const result = await experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^vitest$/, /^react$/] });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
