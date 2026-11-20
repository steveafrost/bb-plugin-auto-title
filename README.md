# Auto Title

Keep the title that still fits. Auto Title rechecks a BB thread after every ten human messages by default. It renames the thread only when the title no longer describes the work, and leaves hand-written titles alone when it can distinguish them.

## Set up

1. Install Auto Title and open **Settings → Plugins → Auto Title**. Set **Model source** and optionally change the interval.
2. To let Auto Title recognize BB’s machine-written titles, choose it under **Settings → AI services → Thread titles**. Leave commit messages and voice on their existing services.

```sh
bb settings ai-services set thread-title auto-title --plugin auto-title
bb auto-title sources
bb auto-title source <source-id>
bb auto-title retitle <thread-id>
```

The last command explicitly replaces a title, even a protected one, and resumes automatic checks. Reloads catch up from the saved cursor; a gap spanning several milestones triggers at most one check.

## Model sources

**Automatic** tries these routes in order. Unavailable routes, errors, and unusable verdicts fall through. Choose a specific source to use only that route.

1. **Custom endpoint**: enter the full OpenAI-compatible chat completions URL, model name, and optional API key in plugin settings. HTTPS is required except on localhost. The secret key stays in BB’s server-side secret settings. Anthropic Messages is not supported as a custom wire format.
2. **BB Cloud**: uses your signed-in BB account with Cloud AI enabled and consumes its AI budget.
3. **Installed AI plugins**: discovers compatible RPCs, skips Auto Title itself, and uses BB’s Automatic order for providers with a registered title service. Other compatible providers are sorted by plugin ID. The picker displays readiness reported by BB; RPC-only providers are listed when their methods are discoverable.
4. **Thread provider**: uses a small model in a short hidden helper on the thread’s provider and host. It needs a host-backed target and a listed small model. The helper has no parent notifications and is stopped and deleted afterward. Providers can bill this like any other session. Automatic only starts a helper when the provider offers automatic permissions. Explicitly choosing Thread provider allows its normal permission mode; a provider can still expose tools.

BB gives a title-service call five seconds and does not pass a thread ID. Auto Title budgets 3.8 seconds for first-title inference and never starts a provider helper there. If no fast route answers, it returns shortened task text; later milestones can improve it. A failed milestone or built-in regeneration keeps the current title.

### Publish a compatible completion RPC

A plugin can opt in by exposing both methods through discoverable plugin RPCs. No AI-service registration is necessary for discovery.

| RPC | Input Auto Title sends | Output Auto Title reads |
| --- | --- | --- |
| `models.list` | `{ scope: "fast_chat" }` | `{ models: [{ id: string, deprecated?: boolean, reasoning?: { supported: boolean, canDisable: boolean } }] }` |
| `chat.complete` | `{ model: string, scope: "fast_chat", prompt: string, maxTokens: 384, timeoutMs: 8000, reasoningEffort?: "none" }` | `{ text: string }` |

The completion handler must accept plugin callers. A prompt contains bounded human text and asks for one JSON verdict: `{"verdict":"keep","title":null}` or `{"verdict":"replace","title":"New thread title"}`. Extra output fields are allowed. A wrapped JSON object is accepted, but a malformed or ambiguous response never updates a title.

## Title protection and inputs

Auto Title keeps up to 256 service-written titles for up to seven days. BB does not provide a thread ID to its AI service, so a hand title identical to a recent generated one can collide. Unattributed titles are otherwise protected, including existing titles on upgrade. A changed result from BB’s **Regenerate title** can clear protection at the next milestone. Auto Title rechecks the title before writing, but BB has no conditional update to eliminate the final read/write race.

Fit checks send the current title and up to 32 short excerpts from the opening, middle, and recent human messages to the selected model. Attachments and agent-only text are excluded. Agent and plugin sends, marked retries, and acceptance events don’t count. An unattributed script using the human send path can count as human.

## Develop locally

```sh
npm ci
npm run typecheck
npm test
npm run build
bb plugin install . --yes
bb plugin reload auto-title
```

Requires BB 0.50.1 with host Plugin SDK 0.6.157 or newer. Released under MIT.
