import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { parseDecision } from "../model";
import { createRoutes, customCompletion, endpoint, type ModelSettings } from "../routes";

const replace = '{"verdict":"replace","title":"A new goal"}';
const signal = () => new AbortController().signal;
const input = '{"title":"Old title","force":true,"messages":["A new goal"]}';
const target = makeThreadResponse({ id: "target", environmentId: "environment" });
afterEach(() => vi.unstubAllGlobals());

function fixture(settings: Partial<ModelSettings> = {}) {
  const calls: string[] = [];
  const service = (pluginId: string, rank: number, ready = true) => ({ pluginId, id: pluginId, tasks: ["thread-title"], automaticRank: rank, status: { ready } });
  const aiServices = vi.fn(async () => ({ services: [service("bb-ai", 0), service("auto-title", 1), service("not-ready", 2, false), service("faster", 3), service("slower", 4)] }));
  const plugins = ["slower", "auto-title", "faster", "not-ready"];
  const callRpc = vi.fn(async ({ pluginId, method }: { pluginId: string; method: string }) => {
    calls.push(`${pluginId}/${method}`);
    if (pluginId === "bb-account") return { status: 200, body: { text: replace } };
    if (method === "models.list") return { models: [{ id: "tiny" }] };
    return { text: replace };
  });
  const spawn = vi.fn(async (_args: unknown) => { calls.push("provider"); return { id: "helper" }; });
  const stop = vi.fn(async (_args: unknown) => {});
  const remove = vi.fn(async (_args: unknown) => {});
  const sdk = {
    plugins: { experimental_discoverRpc: async () => plugins.flatMap((pluginId) => ["chat.complete", "models.list"].map((method) => ({ pluginId, method, displayName: pluginId }))), callRpc },
    system: { aiServices }, environments: { get: async () => ({ hostId: "host" }) }, providers: { list: async () => [{ id: target.providerId, available: true, capabilities: { permissionModes: ["full"] } }], models: async () => ({ models: [{ id: "large" }, { id: "test-mini" }] }) },
    threads: { spawn, stop, delete: remove, get: async () => ({ status: "idle", deletedAt: null }), output: async () => ({ output: replace }) },
  };
  const api = { pluginId: "auto-title", sdk, log: { info: vi.fn(), warn: vi.fn() } } as unknown as BbPluginApi;
  const routes = createRoutes(api, async () => ({ modelSource: "automatic", customUrl: "", customModel: "", ...settings }));
  return { routes, calls, callRpc, spawn, stop, remove };
}

it("tries custom, Cloud, and ranked ready plugins in order, skipping self and failures", async () => {
  const f = fixture({ customUrl: "https://example.com/v1/chat/completions", customModel: "tiny" });
  vi.stubGlobal("fetch", vi.fn(async () => { f.calls.push("custom"); throw new Error("unreachable"); }));
  f.callRpc.mockImplementation(async ({ pluginId, method }) => {
    f.calls.push(`${pluginId}/${method}`);
    if (pluginId === "bb-account") return { status: 503, body: { text: "" } };
    if (method === "models.list") return { models: [{ id: "model" }] };
    return { text: pluginId === "faster" ? "bad verdict" : replace };
  });
  expect(await f.routes.complete(input, signal(), target)).toMatchObject({ verdict: "replace" });
  expect(f.calls).toEqual(["custom", "bb-account/bb-account.v1.fetch", "faster/models.list", "faster/chat.complete", "slower/models.list", "slower/chat.complete"]);
  expect((await f.routes.choices(signal())).map(({ id }) => id)).not.toContain("plugin:auto-title");
  expect(f.spawn).not.toHaveBeenCalled();
});

it("does not call self even if selected directly and does not fall through a pinned route", async () => {
  const f = fixture({ modelSource: "plugin:auto-title" });
  await expect(f.routes.complete(input, signal(), target)).rejects.toThrow("No title model");
  expect(f.calls).toEqual([]);
  const pinned = fixture({ modelSource: "plugin:faster" });
  expect(await pinned.routes.complete(input, signal())).toMatchObject({ verdict: "replace" });
  expect(pinned.calls).toEqual(["faster/models.list", "faster/chat.complete"]);
});

it("uses an explicitly selected Cloud route without changing BB's selection", async () => {
  const f = fixture({ modelSource: "cloud" });
  expect(await f.routes.complete(input, signal())).toMatchObject({ verdict: "replace" });
  expect(f.calls).toEqual(["bb-account/bb-account.v1.fetch"]);
});

it("does not start a helper on first-title calls; otherwise isolates and removes it", async () => {
  const f = fixture({ modelSource: "provider" });
  await expect(f.routes.complete(input, signal())).rejects.toThrow("No title model");
  expect(f.spawn).not.toHaveBeenCalled();
  expect(await f.routes.complete(input, signal(), target)).toMatchObject({ verdict: "replace" });
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ model: "test-mini", originPluginId: "auto-title", visibility: "hidden", title: "Auto Title helper", parentNotifications: "off", pluginMetadata: { helper: true } }));
  expect(f.stop).toHaveBeenCalledWith({ threadId: "helper" });
  expect(f.remove).toHaveBeenCalledWith({ threadId: "helper", childThreadsConfirmed: true });
});

it("does not elevate a helper to full permissions in Automatic", async () => {
  const f = fixture();
  f.callRpc.mockRejectedValue(new Error("Fast sources unavailable"));
  await expect(f.routes.complete(input, signal(), target)).rejects.toThrow("No title model");
  expect(f.spawn).not.toHaveBeenCalled();
});

it("validates custom URLs and never includes API keys or remote error bodies in failures", async () => {
  expect(endpoint("http://localhost:8012/v1/chat/completions").hostname).toBe("localhost");
  for (const url of ["http://example.com/", "https://user:fake-key@example.com", "https://example.com/?key=fake-key", "file:///tmp/x"]) expect(() => endpoint(url)).toThrow(/^Enter an HTTPS/);
  const config = { modelSource: "custom", customUrl: "https://example.com/v1/chat/completions", customApiKey: "fake-key", customModel: "tiny" };
  const respond = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: replace } }] })));
  expect(await customCompletion(config, input, signal(), respond)).toBe(replace);
  expect(respond).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ authorization: "Bearer fake-key" }) }));
  await expect(customCompletion(config, input, signal(), async () => { throw new Error("leaked fake-key"); })).rejects.toThrow(/^Custom completion failed$/);
});

it("accepts one wrapped verdict but not multiple objects or loose prose", () => {
  expect(parseDecision(`Result:\n\`\`\`json\n${replace}\n\`\`\``)).toMatchObject({ verdict: "replace" });
  for (const raw of ["Looks fine", `${replace}\n${replace}`, '{"verdict":"replace"}', '{"verdict":"replace","title":""}']) expect(() => parseDecision(raw)).toThrow();
});
