# Thinking budget for OpenRouter model requests

Research date: 2026-09-08. Question: should the app cap thinking on its
OpenRouter requests to stop requests that end after thinking with no answer?

## Recommendation

Send one global `reasoning: { effort: "low", exclude: true }` on every
OpenRouter chat-completion body built by `chatCompletionBody`, and record the
setting in the benchmark report's `researchSettings` alongside the existing
binding and routing entries. `low` is honoured by all five reasoning-capable
models in the sweep (gpt-oss-20b, gpt-oss-120b, gpt-5-nano, deepseek-v4-flash,
glm-5.3-flash), it is the smallest uniform reduction from today's defaults
(medium/medium/minimal-equivalent/high/max), it directly shrinks the two
failure classes most plausibly caused by unbounded thought (the six 300s
`request_timeout`s with ~10 MB on the wire and no answer, and the six
`answer_overrun`s), it cuts billed output tokens without touching the judge,
the bindings, or what an assessment measures — and `exclude: true` additionally
removes reasoning bytes from the wire so a thinking stream can no longer hold
the silent timer open for five minutes. It will not fix the 37 Groq 502
`upstream_error`s (a route fault, not a thinking fault); those stay owned by
the route-rest mechanism.

## 1. What the app sends today

- `chatCompletionBody` (`apps/server/src/llm/providers.ts:1104-1142`) sends
  `model`, `messages`, and binding fields only. It sends **no `reasoning`
  parameter and no `max_tokens`**, so every model thinks at its own default
  depth. The only `max_tokens` in the file is `max_tokens: 8192` on the
  Anthropic-messages path (`providers.ts:1050`), which OpenRouter
  chat-completion calls never use.
- The stream reader already knows about reasoning: `carriesReasoningActivity`
  (`providers.ts:696-709`) recognises `reasoning`, `reasoning_content`, and
  `reasoning_details` deltas per
  https://openrouter.ai/docs/guides/best-practices/reasoning-tokens, and
  `reasoningLength` (`providers.ts:715-729`) counts their characters without
  retaining the text.

## 2. Which `reasoning` parameters OpenRouter accepts

Source: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
(all quotes below are from that page).

- `reasoning.effort`: one of `max`, `xhigh`, `high`, `medium`, `low`,
  `minimal`, `none` (OpenAI-style). `max`/`xhigh` ≈ 95% of `max_tokens` for
  reasoning, `high` ≈ 80%, `medium` ≈ 50%, `low` ≈ 20%, `minimal` ≈ 10%,
  `none` disables reasoning. Officially supported by "OpenAI reasoning models
  (o1 series, o3 series, GPT-5 series) and Grok models"; for
  `max_tokens`-only models the value is mapped to an effort level.
- `reasoning.max_tokens`: a token cap (Anthropic-style). Officially supported
  by "Gemini thinking models", "Anthropic reasoning models", and "some Alibaba
  Qwen thinking models (mapped to `thinking_budget`)"; support varies by Qwen
  model. For effort-only models the cap is mapped to an effort level.
- `reasoning.exclude` (default `false`): "All models support this." `true`
  keeps the model thinking internally but strips reasoning tokens from the
  response — i.e. from the streamed wire this app reads.
- `reasoning.enabled: true`: enables reasoning at medium effort with no
  exclusions.
- Per-model discovery via `GET /api/v1/models`: each model may expose
  `reasoning.supported_efforts` (descending), `reasoning.default_effort`,
  `reasoning.default_enabled`, `reasoning.supports_max_tokens`, and
  `reasoning.mandatory` ("when `true`, hide disable controls and do not send
  `effort: "none"` — the model rejects it").
- Billing: "Reasoning tokens are considered output tokens and charged
  accordingly." First-party parallel: OpenAI bills reasoning tokens as output
  tokens, and warns that a cap reached before visible output means "you could
  incur costs for input and reasoning tokens without receiving a visible
  response" (https://developers.openai.com/api/docs/guides/reasoning).

## 3. Per-model support and defaults

OpenRouter metadata below is live `GET https://openrouter.ai/api/v1/models`
(state as read 2026-09-08); first-party rows are the model owners' own docs.

| Model (as configured in sweep arms) | OpenRouter `reasoning` metadata | First-party default / honoured params |
|---|---|---|
| `openai/gpt-oss-20b` | efforts high/medium/low, default **medium**, mandatory true | Three efforts low/medium/high, "set the reasoning effort with one sentence in the system message" (https://openai.com/index/introducing-gpt-oss/). Effort honoured via OpenRouter `effort`. |
| `openai/gpt-oss-120b` | efforts high/medium/low, default **medium**, mandatory true | Same as 20b (same announcement page). |
| `openai/gpt-5-nano` | efforts high/medium/low/minimal, default **medium**, mandatory true | Effort values are model-dependent (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`); "defaults are also model-dependent rather than universal" (https://developers.openai.com/api/docs/guides/reasoning). |
| `deepseek/deepseek-v4-flash-0731` | efforts max/high/low, default **high**, mandatory false | Native API takes `thinking: {"type": "enabled"}` plus `reasoning_effort` (example uses `"high"`) (https://api-docs.deepseek.com/guides/reasoning_model). Effort honoured via OpenRouter `effort`. |
| `qwen/qwen3.6-35b-a3b` | no `supported_efforts`, no `default_effort`; `default_enabled: true`, mandatory false | Hybrid thinking, **thinking enabled by default**; per-request switch is `enable_thinking` (extra_body, OpenAI-compatible), and `thinking_budget` "defaults to the model's maximum chain-of-thought length" (https://www.alibabacloud.com/help/en/model-studio/deep-thinking). Open-source Qwen3 default `enable_thinking: True` (https://qwenlm.github.io/blog/qwen3/). OpenRouter maps `max_tokens` to `thinking_budget` only where the model supports it — this model's metadata exposes neither efforts nor `supports_max_tokens`, so only `exclude` is certain to act on it. |
| `z-ai/glm-5.3-flash` (benchmark judge, `provenance.judgeModel`) | efforts max/high/low, default **max**, mandatory true | "Always operates with reasoning enabled", efforts `low`/`high`/`max`, default **`max`**; `thinking.type` only `enabled`, "disabling reasoning is no longer supported" (https://docs.z.ai/guides/llm/glm-5.3). Note the judge runs at the deepest default of all six models. |

Consequences: `effort: "low"` is in every model's `supported_efforts`
except Qwen (which exposes none — `low` is accepted and mapped or ignored,
never rejected, per the "for models that only support `max_tokens`, the
effort level will be set based on the percentages" rule). `effort: "none"`
MUST NOT be sent globally: three of the six models are `mandatory: true` and
reject it. `max_tokens` MUST NOT be the global mechanism: only Qwen-style
models honour it and Qwen3.6-35b-a3b does not even advertise
`supports_max_tokens`.

## 4. How thinking interacts with the stream guards

All line references are `apps/server/src/llm/providers.ts` unless noted.

- **Reasoning counts toward the answer ceiling.** `answerChars = content.length
  + reasoningChars + tool-args` (`providers.ts:632-633`), and the ceiling is
  `MODEL_STREAM_MAX_ANSWER_CHARS = 250_000`
  (`packages/shared/src/llm.ts:61`), which counts "content, tool-call
  arguments, and reasoning by length alone" (`llm.ts:41-44`). A runaway
  reasoner is an explicitly anticipated case: "a runaway reasoner produced
  161,416 characters" (`llm.ts:48`).
- **Reasoning keeps the connection alive.** Any reasoning delta resets the
  90 s silent timer (`providers.ts:543-546`, `armIdle`), and any byte resets
  the 30 s idle timer (`providers.ts:598`). The constants:
  `MODEL_STREAM_IDLE_TIMEOUT_MS = 30_000` (`llm.ts:25`),
  `MODEL_STREAM_SILENT_TIMEOUT_MS = 90_000` (`llm.ts:39`),
  `MODEL_REQUEST_TIMEOUT_MS = 300_000` (`llm.ts:16`). So an uninterrupted
  thinking stream can hold a call open until the 300 s absolute ceiling —
  exactly the `request_timeout` signature in §5 (timeoutMs 300000, megabytes
  of body, no answer).
- **Thinking-only end state is `unusable_shape`.** When the stream closes with
  no content and no tool call, `readChatCompletionContent` /
  `readToolCallArguments` throw `unusableShape` (`providers.ts:874-912`). The
  binding ladder recovers from `unusable_shape` **only** when the answer
  landed in the wrong field — `diagnostic.populatedFields` contains
  `*.content` (`providers.ts:1482-1500`, "an answer that is empty everywhere
  is not going to be better at the next binding, and keeps its report"). A
  genuinely thinking-only reply (empty everywhere) is terminal for that call.
  The 20 `unusable_shape` attempts in the data are all the recoverable kind
  (content populated, tool_calls empty, `finish_reason: stop` — see §5), i.e.
  evidence of thought-then-wrong-field, not thought-then-nothing.

## 5. Tally re-derivation from the arm data

Method: every `attempts[]` entry with `stage: "extraction"` and
`code: "model-boundary-failed"` in
`/private/tmp/person-benchmark-sweep-2026-09-08/<arm>/<model>/*.operation.json`,
grouped by the classification prefix of `reason`. (All extraction attempts
are also all model-boundary attempts — no other stage carries the code in
these arms.)

| Classification | Claimed | Re-derived (iter1-fixed oss20b+nano) | Verdict |
|---|---|---|---|
| `upstream_error` | 38 | 38 (37 oss20b + 1 nano) | confirmed |
| `unusable_shape` | 20 | 20 (all oss20b) | confirmed |
| `request_timeout` | 9 | **6** in iter1-fixed (2 forced_tool_call via CoreWeave + 4 response_format via DeepInfra/Novita/Phala/Parasail, all timeoutMs 300000) | **corrected scope**: 9 only when adding iter1-live nano — 1 extraction `request_timeout` + 2 planning-model 90 s-ceiling timeouts (`live-discovery-expanded-ad1d1d6b8267a6e0-{kristalina-georgieva,irene-tracey,hilary-cottam}.operation.json` in `iter1-live/openai__gpt-5-nano/`) |
| `answer_overrun` | 6 | 6 (all oss20b) | confirmed |

Unclaimed-but-present in the same scope: `answer_not_json` 2,
`repetition_loop` 2. iter2-fixed is a different regime and is out of scope
for the claim: its 64 `http_error`s are HTTP 402 (sample:
`iter2-fixed/openai__gpt-oss-20b/*.operation.json`, status 402,
`topLevelKeys: ["error", "user_id"]`) — a quota/credit refusal, not thinking.

Thinking-attribution per class (inference flagged as such — the seam records
shape only; reasoning text is never retained, `providers.ts:480-482`):

- `request_timeout` (6): strongest thinking signal. All fired at the 300 s
  absolute ceiling (never the 30 s/90 s timers, which reasoning activity
  resets) with 9.7–11.8 MB of wire and empty answer fields — e.g. the
  DeepInfra response_format attempt at 11,805,910 bytes. A stream that
  delivers megabytes while accumulating under 250,000 answer chars across
  five minutes is a thinking stream.
- `answer_overrun` (6): consistent with a reasoner crossing 250,000 chars
  without finishing (largest wire observed: 10,715,898 bytes, Google route,
  response_format, no finish reason).
- `unusable_shape` (20): all finish `stop` with `populatedFields:
  choices[0].message.role/content` and `emptyFields:
  choices[0].message.tool_calls` — 12 via Amazon Bedrock, 8 via CoreWeave —
  the documented "task done in content under a forced named function"
  signature (`providers.ts:1475-1479`, measured on gpt-oss-20b). Long thought
  followed by a wrong-field answer; the ladder already recovers these, so a
  budget helps only indirectly (less thought → less drift).
- `upstream_error` (37+1): all Groq 502s (`upstreamCode: 502`, 358-byte
  error envelope). A route fault. No thinking mechanism addresses it.

## 6. Options

Benchmark-condition context (applies to all options): the report records
research settings in `provenance.researchSettings`
(`scripts/person-research-benchmark.mts:504-517`), so any budget must be added
there or assessments stop being comparable; the judge is pinned
(`JUDGE_VERSION = "2026-09-06.10"`,
`apps/server/src/person-benchmark/judge.ts:24`; sweep arms record
`judgeVersion: "2026-09-06.9"`), and none of the options below touch it.
Cost context: usage accounting is "logical request text and returned answer
characters" with tokens/cost `"unavailable"`
(`person-research-benchmark.mts:508-524`) — reasoning tokens are invisible in
today's reports but billed by OpenRouter as output tokens (§2), so every
uncapped thought is paid for twice: once in money, once in failures.

1. **Global `reasoning.effort: "low"`.** Honoured by oss20b/oss120b
   (low∈efforts), nano (low∈efforts), deepseek (low∈efforts), glm-flash
   (low∈efforts); accepted-or-ignored by Qwen (no advertised efforts).
   Benchmark: one new `researchSettings` line, same for every arm — comparisons
   stay valid. Cost: reasoning share drops from ~50–100% of output to ~20%,
   cutting the largest billed-token category on every call. Coverage: shrinks
   the thinking mass behind `request_timeout` and `answer_overrun`; does not
   fix Groq 502s; only indirectly helps `unusable_shape`.
2. **Global `reasoning.max_tokens` cap.** Rejected as the global mechanism:
   only Qwen-style models honour it, and the one Qwen in the sweep does not
   advertise `supports_max_tokens` (§3). As a Qwen-only adjunct it is
   reasonable but adds per-model branching for the model least implicated in
   the tallies (zero Qwen attempts in the four classes — the tallies are all
   oss20b/nano).
3. **Global `reasoning.exclude: true` (alone or with effort).**
   Universally supported (§2) and orthogonal: it does not reduce thought, it
   removes reasoning bytes from the streamed response. Benchmark: same
   single-line reporting as (1). Cost: does not cut billed tokens (the model
   still thinks) but cuts wire bytes and bodyBytes accounting. Coverage: does
   not prevent long thought, but a thinking stream can no longer reset the
   silent timer or inflate `answerChars`, so runaway thought surfaces as a
   fast 90 s `request_timeout` instead of a 300 s one or an `answer_overrun`
   — strictly better failure shape for the same underlying event. No
   assessment-measure change: the answer contract is untouched.
4. **Per-model budgets** (e.g. glm-flash `max`→`high`, deepseek `high`→
   `medium`, oss `medium`→`low`). Finer control and the only way to give the
   judge (default `max`, deepest of the six) a different budget from research
   models. Cost of the option itself: a model→effort table is a new
   per-assessment variable that must be recorded per arm and kept in sync
   with the model roster; a global floor-plus-override is the cheaper variant.
   Nothing in the tallies demands it — all four classes are oss20b/nano,
   both `medium` today.
5. **Reasoning exclusion at the guard level** (stop counting reasoning toward
   `answerChars`, or stop letting it reset the silent timer). NOT
   recommended: it blinds the one ceiling that catches runaway reasoners
   (§4, `llm.ts:48`), converting today's `answer_overrun`s into longer,
   more expensive 300 s timeouts. The guards' current treatment of reasoning
   is correct; the request should simply ask for less of it.

## 7. What changes, what does not

- Changes: request bodies gain one `reasoning` object; `researchSettings`
  gains the matching line; reasoning token spend falls; thinking-attributed
  `request_timeout`/`answer_overrun` attempts should fall with it.
- Does not change: judge configuration (still `2026-09-06.10`, still
  glm-5.3-flash unless separately decided), binding ladder and its recovery
  rule, timeout/overrun ceilings, what an assessment measures, or Groq route
  reliability (37 of the 73 tallied attempts need the route-rest fix, not a
  thinking fix).
- Suggested follow-up, not part of this change: record per-attempt reasoning
  char counts (already computed in memory, `providers.ts:482`) in the
  shape-only diagnostic so the next sweep can attribute thought directly
  instead of via wire-byte inference.

---

# Addendum (2026-09-08, same day): verification of the two open questions

Method for the arm-data claims below: every `attempts[]` entry with
`stage: "extraction"` in
`/private/tmp/person-benchmark-sweep-2026-09-08/iter1-fixed/openai__gpt-oss-20b/*.operation.json`
(30 files) plus
`/private/tmp/person-benchmark-sweep-2026-09-08/iter1-fixed/openai__gpt-5-nano/*.operation.json`,
grouped by `(observed.modelBoundary, configuration.wireAttempt, configuration.logicalCall)`.
OpenRouter metadata claims are live `GET https://openrouter.ai/api/v1/models`
(426 models) and `GET .../models/<slug>/endpoints`, re-read 2026-09-08; they
reproduce the §3 table exactly. No code was changed for this addendum.

## 8. Per-model `reasoning: { effort: "low" }` verdicts (refines §3)

The §3 table is confirmed as read. The §3 Qwen cell ("accepted and mapped or
ignored") is refined to **accepted, silently ignored (no-op)** on the evidence
below; the other five cells stand as "honoured". The recommendation (global
`low` + `exclude: true`) is unchanged: `low` is in every advertised
`supported_efforts` list, `none` is still forbidden (three models
`mandatory: true`), and `exclude: true` is still the only field certain to act
on all six ("All models support this",
https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

| Model | Live OpenRouter `reasoning` metadata | First-party source | Verdict on `effort: "low"` |
|---|---|---|---|
| `openai/gpt-oss-20b` | efforts high/medium/low, default medium, mandatory true | "support three reasoning efforts—low, medium, and high" (https://openai.com/index/introducing-gpt-oss/) | **Honoured** — `low` is an advertised effort. |
| `openai/gpt-oss-120b` | efforts high/medium/low, default medium, mandatory true | Same announcement page as 20b | **Honoured** — `low` is an advertised effort. |
| `openai/gpt-5-nano` | efforts high/medium/low/minimal, default medium, mandatory true | Effort values "model-dependent", "defaults are also model-dependent rather than universal" (https://developers.openai.com/api/docs/guides/reasoning) | **Honoured** — `low` is an advertised effort. |
| `deepseek/deepseek-v4-flash-0731` | efforts max/high/low, default high, mandatory false | Native API takes `thinking: {"type": "enabled"}` + `reasoning_effort` (example `"high"`); `deepseek-v4-flash` updated to `DeepSeek-V4-Flash-0731` (https://api-docs.deepseek.com/guides/reasoning_model) | **Honoured** — `low` is an advertised effort, mapped to `reasoning_effort`. |
| `qwen/qwen3.6-35b-a3b` | `{mandatory: false, default_enabled: true}` only — no `supported_efforts`, no `default_effort`, no `supports_max_tokens` | Hybrid thinking toggled per request by `enable_thinking` (extra_body), `thinking_budget` "defaults to the model's maximum chain-of-thought length" (https://www.alibabacloud.com/help/en/model-studio/deep-thinking); open-source default `enable_thinking: True` (https://qwenlm.github.io/blog/qwen3/) | **Accepted, silently ignored** — see below. |
| `z-ai/glm-5.3-flash` | efforts max/high/low, default max, mandatory true (+`default_enabled: true`) | "supports three reasoning effort levels: `low`, `high`, and `max`", default `max`, `thinking.type` only `enabled`, "disabling reasoning is no longer supported" (https://docs.z.ai/guides/llm/glm-5.3) | **Honoured** — `low` is an advertised effort, mapped to `reasoning_effort`. |

Why Qwen is "ignored" and not "mapped": (a) OpenRouter's rule for the
`supported_efforts` field is "when omitted, the model does not expose effort
selection" (reasoning-tokens guide); (b) the effort→budget mapping needs a
budget knob and this slug omits `supports_max_tokens` ("omitted when the model
does not support token-budget reasoning"), while its siblings advertise it —
`supports_max_tokens: true` is present on exactly 10 of 426 models, including
`qwen/qwen3.8-flash` and `qwen/qwen3.7-flash`, but not `qwen/qwen3.6-35b-a3b`;
(c) the native Qwen control plane has no effort knob at all — only
`enable_thinking` (on/off) and `thinking_budget` (cap) — so there is nothing
for a forwarded `effort` to act on, and OpenRouter's routing rule for
unsupported parameters is that the provider "will ignore unknown parameters"
(https://openrouter.ai/docs/guides/routing/provider-selection); (d) the
gateway will still accept the field: all 10 endpoints serving
`qwen/qwen3.6-35b-a3b` (Darkbloom, AkashML, DeepInfra, Venice, Io Net,
Parasail, AtlasCloud, Phala, SiliconFlow, CoreWeave — endpoints API, 2026-09-08)
list `reasoning` in `supported_parameters`. Net: `effort: "low"` rides along
and changes nothing; thinking stays at its default (enabled, full budget).
Whether the `max_tokens`→`thinking_budget` mapping applies to
qwen3.6-35b-a3b: **it does not on OpenRouter** — the mapping is offered only
where `supports_max_tokens` is advertised, and this slug does not advertise it
(native `thinking_budget` exists in Alibaba's own API for the Qwen3.6 family,
but OpenRouter does not expose the mapping for this slug).

## 9. Groq 502s: cause and exclusion cost

### 9.1 What the 38 `upstream_error`s are

All 38 are `binding: forced_tool_call`, `upstreamCode: 502`, HTTP `status: 200`
(37 via Groq on oss20b, 1 via OpenAI on gpt-5-nano with a 287-byte envelope vs
Groq's 358). `status: 200` with an `error` object is OpenRouter's documented
"failure after the provider accepted the request" shape: "OpenRouter sends you
the HTTP `200 OK` status and headers as soon as the provider accepts the
request... Every failure after that point is therefore reported inside the
response", and code 502 means "your chosen model is down or we received an
invalid response from it"
(https://openrouter.ai/docs/api_reference/errors-and-debugging).

### 9.2 Cause: upstream inference-start failure, not parameter forwarding

- **Not bad-parameter forwarding.** A rejected parameter fails before the
  stream commits: pre-stream 400 "invalid or missing params" with OpenRouter
  failover to another endpoint still possible (same errors page). These calls
  were accepted and then failed with zero tokens delivered — `bodyBytes` counts
  raw stream bytes (`providers.ts:594`) and 358 bytes is the error envelope
  alone. None of the three candidate fields is implicated: `tools` +
  named `tool_choice` are supported on Groq's gpt-oss-20b ("All models hosted
  on Groq support tool use", gpt-oss rows ✅,
  https://console.groq.com/docs/tool-use), and OpenRouter deliberately routes
  tool requests to supporting providers ("makes a best effort to route to
  providers known to support tool use", provider-selection guide); strict
  `json_schema` never went to Groq (zero Groq `response_format` attempts in the
  arm — the six `request_timeout`/`answer_overrun`/`answer_not_json`/
  `repetition_loop` response_format attempts are DeepInfra/Google/Novita/
  Parasail/Phala); unioned declarations are not the mechanism either (a
  declaration gap refuses with 404 pre-stream and the ladder steps down,
  `providers.ts:1307-1316,1427-1471`).
- **Not capacity.** Capacity refusals are 429 (+`Retry-After`), classified
  `http_error`, and rest the route (`providers.ts:1207-1214`). 502 is a
  different documented meaning (model down / invalid response), and 16 of the
  21 first-attempt Groq 502s were retried onto Groq and 502'd again within the
  same logical call — a saturated route would shed load, not fail identically
  twice.
- **Not deterministic.** 39 Groq `forced_tool_call` attempts exist in the arm:
  37 failed fast at inference start and 2 streamed past the 250,000-char
  ceiling (`answer_overrun` via Groq, e.g. logicalCall `5346bbea-...` wire 2 and
  `3b9e21e4-...` wire 2). Groq accepts the binding and usually dies at
  generation start, occasionally runs away instead.
- **The failure mode follows the binding, not Groq alone.** The nano attempt
  via the OpenAI route is the identical signature (200 + `error.code` 502,
  `forced_tool_call`, zero tokens) on a different provider
  (`fixed-documents-expanded-d14ba12d34e2998b-bong-joon-ho.operation.json`),
  matching the seam's own precedent: constrained tool-call/JSON decoding that
  fails upstream surfaces as "HTTP 200 carrying upstream code 502"
  (`providers.ts:211-223`, the `maxLength` strip).
- **Limit (inference, flagged as such).** The exact Groq-side message is
  unrecoverable from the arm data by design: the diagnostic retains codes,
  keys, byte counts and field flags but never `error.message`
  (`modelBoundaryFailure`, `apps/server/src/llm/failure.ts:201-221`; identifiers
  are allow-listed, `failure.ts:237-257`). Follow-up: retain
  `error.message`/`metadata.error_type` in the shape-only diagnostic so the
  next sweep can separate "model down" from "invalid response".

### 9.3 The app amplifies it: retry re-lands on Groq because nothing rests

`isUpstreamCapacityRefusal` treats `upstream_error` with code 502/503/504 as
capacity and grants one same-binding retry (`failure.ts:125-131`,
`providers.ts:1342-1354`), but `restFailedRoute` rests only
`repetition_loop` / `answer_overrun` / `request_timeout` / 429-`http_error`
(`providers.ts:1204-1214`) — `upstream_error` rests nothing, so the retry
re-sends with unchanged `ignore` and `sort: "throughput"` picks Groq again.
Measured: 21 Groq 502s at wireAttempt 1, 16 more at wireAttempt 2, including 16
logical calls with Groq→Groq double-502s (e.g. logicalCall `2c06a6cc-...` wire
1–2). Two compounding facts: the app's `sort: "throughput"` disables
OpenRouter's outage-aware load balancing ("if you have `sort` or `order` set
... load balancing will be disabled", provider-selection guide), which
otherwise deprioritises providers "that have seen significant outages in the
last 30 seconds" — so the client-side rest list is the only protection, and
this classification bypasses it.

### 9.4 Excluding Groq: mechanism and cost

The mechanism exists and is proven: resting routes ride as `provider.ignore`
(`providers.ts:1326-1332`), the stream-reported route name round-trips without
a catalogue lookup (`providers.ts:1317-1325`; `failure.ts:245-250`), and the
rest lifecycle is per-(model, route), 15-minute cooldown, bounded at 8
(`providers.ts:1162-1195`). Three ways to exclude Groq, cheapest first:

1. **Config, no code (account-wide, not per-model).** OpenRouter dashboard
   privacy settings → account-wide ignored providers, "merged with your
   account-wide ignored providers" on every request
   (provider-selection guide, "Ignoring Providers"). Zero repo change, dashboard
   revert; affects every key/traffic on the account and lives outside the repo.
2. **Code, one line, static.** Seed `ignore` with `"Groq"` in
   `openAiCompatibleComplete` (`providers.ts:1326-1332`). Base slugs match all
   of a provider's endpoints (provider-selection guide). Deterministic and
   revertible; static where the rest list is adaptive.
3. **Code, adaptive.** Add `upstream_error` (or its 502 subset) to the
   `routeFailed` set in `restFailedRoute` (`providers.ts:1207-1214`), so a Groq
   502 rests `openai/gpt-oss-20b→Groq` for 15 minutes like any other route
   fault. Per-model and self-reversing, but it also rests the OpenAI route
   after the nano-style 502 and treats transient inference blips as route
   faults.

There is no in-repo config surface for this today: `LlmConfig` carries only
`provider`/`model`/`apiKey`/`baseUrl` (`providers.ts:31-36`) and
`CompletionRequest` only `preferredMinThroughput` (`providers.ts:87`), so
options 2–3 are code changes in the request path (`chatCompletionBody` callers
via `openAiCompatibleComplete`, `providers.ts:1258-1333`), reported in
`researchSettings` like any routing change. Scope check: 14 endpoints serve
`openai/gpt-oss-20b` including Groq (endpoints API, 2026-09-08: Darkbloom,
AkashML, CoreWeave, DeepInfra, Parasail, Phala, Novita, SiliconFlow, Together,
2× Amazon Bedrock, Google, Fireworks, Groq) — ignoring Groq leaves 13, and
OpenRouter warns that ignoring "may significantly reduce fallback options"
(provider-selection guide).
---

# §10. Future-proofing: safe by default for unknown models and routes (2026-09-08, same day)

Question asked after the adaptive fix (rest on `upstream_error`, so a 502
rests the route instead of being retried onto it) was approved: future models
and routes will be tested and used — how to make unknown futures safe by
default rather than patched case by case? Method: this repo's source (line
refs below are current), OpenRouter's provider-selection / reasoning-tokens /
errors-and-debugging docs (re-read 2026-09-08), and live `GET
https://openrouter.ai/api/v1/models` (426 models, read 2026-09-08; keyless).
No code changed; no paid calls made.

## 10.1 What breaks today when a brand-new model or route appears

Four cold-start gaps, in the order a first call meets them:

1. **Cold-start rests: the first failure pays full price.** `routeRest`
   starts as an empty process-wide map (`providers.ts:1162`), is never
   seeded, never persisted, and is keyed per (model, route)
   (`providers.ts:1174-1177`). A brand-new route therefore routes at full
   weight until a classified route-fault rests it — and before the approved
   adaptive fix, an `upstream_error` 502 did not even do that
   (`restFailedRoute`, `providers.ts:1204-1214` rests only
   `repetition_loop` / `answer_overrun` / `request_timeout` / 429-`http_error`),
   so the one same-binding retry re-sent with unchanged `ignore` and
   `sort: "throughput"` picked the same route again (§9.3: 16 Groq→Groq
   double-502s). Mitigation already in place for the *first* attempt:
   `preferred_min_throughput` only deprioritizes slow routes, never excludes
   them, "so a stale number degrades to today's order instead of failing"
   (`providers.ts:82-87`), and extraction sets it to 50 tok/s
   (`EXTRACTION_PREFERRED_MIN_THROUGHPUT = 50`,
   `apps/server/src/person-profile/research.ts:85`). There is deliberately
   no catalogue seeding — ADR-0068 rejects catalogue labels as going stale
   (`providers.ts:1219-1226`).
2. **Unknown declared bindings: safe, but each rung costs a call.** The seam
   unions `supported_parameters` across all of a model's endpoints
   (`readDeclaredParameters`, `providers.ts:1601-1621`), and `null`
   (unreadable, brand-new, or parameter-less endpoints) walks the full
   ladder `response_format → forced_tool_call → prompt_only`
   (`declaredBindings`, `providers.ts:1641-1645`). A future *new* binding
   parameter is unrecognized by `declares` (`providers.ts:1246-1251`), so it
   can only resolve to `response_format`-first or `prompt_only` — both
   conservative (`prompt_only` "asks nothing of the provider",
   `providers.ts:1245`). The cost of total ignorance is one failed wire
   attempt per rung, and the union's known over-promise (a declared binding
   no single route honours, `providers.ts:1307-1316`) is already absorbed by
   the 404 step-down (`providers.ts:1451-1471`) and the
   rests-exhausted-404 clear (`providers.ts:1419-1450`). No change needed;
   this is the pattern §10.2 copies.
3. **Unknown reasoning metadata: send-and-ignore is NOT provably safe for
   every future model.** Live counts (2026-09-08, 426 models): 157 advertise
   `supported_efforts`, 126 carry no `reasoning` field at all, 105 carry
   `mandatory` only, 34 `default_enabled`+`mandatory`, 4 the
   `supports_max_tokens` variant — and **23 advertised effort lists omit
   `low`** (e.g. `sakana/sakana-namazu` [high, none],
   `google/gemini-3.1-flash-image` [high, minimal],
   `sakana/fugu-ultra` [max, xhigh, high], `z-ai/glm-5.2` [xhigh, high],
   `nvidia/nemotron-3-ultra-550b-a55b` [high, medium],
   `openai/gpt-5.5-pro` [xhigh, high, medium]; 100 models are
   `mandatory: true`). The docs define the two known cases — omitted means
   "the model does not expose effort selection", `null` means "all gateway
   effort values are accepted" (reasoning-tokens guide, "Discovering
   per-model reasoning options") — but **say nothing about sending an
   effort value absent from a non-null list**. The "ignore unknown
   parameters" rule (provider-selection guide: "providers that don't support
   all the LLM parameters specified in your request can still receive the
   request, but will ignore unknown parameters") covers unknown
   *parameters* per endpoint, not out-of-list *values*. `mandatory: true`
   only forbids `effort: "none"` ("do not send `effort: "none"` — the model
   rejects it", same guide). So for today's six models global `low` is
   honoured-or-no-op (§8), but for a future `[high, none]` or
   `[max, xhigh, high]` model an unlisted `low` is undocumented behaviour —
   possibly ignored, possibly a 400 `invalid_request`. The only
   documented-universal primitive is `exclude: true` ("All models support
   this", reasoning-tokens guide). Design consequence (§10.2): never send a
   blind global effort; resolve per model against `supported_efforts` at
   send time and omit when unlisted.
4. **Unknown failure shapes: classified by envelope, never by code — with
   two gaps.** Every throw site names its classification explicitly, and the
   classifier reads *shape*: 2xx + `error` member → `upstream_error`
   whatever the numeric code (`carriesUpstreamError`,
   `providers.ts:786-791`; `parseProviderPayload`, `providers.ts:827-834`);
   non-2xx → `http_error` (`providers.ts:800-810`); empty → `empty_body`;
   non-JSON → `unparseable_body`; nothing in the binding's
   field → `unusable_shape`; non-JSON text → `answer_not_json`. Numeric
   codes and `error_type` are *data*, matched in exactly three places:
   `isUpstreamCapacityRefusal` (429 anywhere, or `upstream_error` +
   502/503/504 — `failure.ts:123-132`), the 404 discriminators
   (`providers.ts:1427-1454`), and the `refusesBinding` 4xx regexes
   (`providers.ts:1552-1561`). Consequences for a never-seen error: (a) a
   future numeric code inside an `error` envelope is still `upstream_error`
   — with the approved fix it rests the route, and it gets the one
   same-binding retry only if the code is 502/503/504
   (`providers.ts:1349-1354`); anything else (e.g. a future 5xx or a typed
   `timeout`) rests-but-does-not-retry. Correct default: an unrecognized
   post-accept failure should move routing, not spend the same route twice.
   (b) A future *pre-stream* failure names no route (`upstreamServer`
   null → `restFailedRoute` returns early, `providers.ts:1204-1206`): HTTP
   402 quota → `http_error`, terminal — correct, retrying quota burn is
   wrong (iter2-fixed evidence, §5). But pre-stream 503 ("no available
   model provider that meets your routing requirements",
   errors-and-debugging guide) → `http_error`, terminal, rests nothing and
   retries nothing — a gap only in the sense that nothing *can* rest
   without a route name; the honest handling is surface-and-stop, which is
   what happens. (c) The seam never reads OpenRouter's stable programmatic
   signal at all: `error.metadata.error_type` / `provider_code`
   (errors-and-debugging guide, "Typed error codes": `rate_limit_exceeded`,
   `provider_overloaded`, `provider_unavailable`, `invalid_request`,
   `timeout`, `server`, `unmapped`, …) and the 429/503 `Retry-After`
   header appear nowhere in `apps/server/src/llm`, `scripts`, or
   `packages/shared/src` (grep 2026-09-08: zero hits at the seam; the only
   `Retry-After` handling in the repo is per-request source reading in
   `research-readers.ts:1920-1983`, not the model seam). Any future error
   distinguishable only by `error_type` is therefore classified by its
   numeric shadow. That works today and is one mapping table away from
   breaking the day codes collide.

## 10.2 The future-proof rest policy

**Rest on the classified diagnostic, never on names.** The rest predicate
takes only `(classification, upstreamCode, status, upstreamServer)` — no
provider, route, or model strings anywhere in the policy, so there is no
list to go stale (the same reason `sort: "throughput"` replaced
`require_parameters`, `providers.ts:1307-1316`, and the reason the
stream-reported route name round-trips with no catalogue lookup,
`providers.ts:1317-1325`). `upstream_error` belongs in the rest set
permanently under one condition: **the code is absent or ≥ 500**. Rationale:
a 200-plus-`error`-envelope means the route accepted the call and then
failed it, which implicates the route whatever the future code says; a
4xx-coded envelope (`invalid_request`, `content_policy_violation`,
`refusal` — all HTTP 400 per the typed-codes tables) names a request that
is wrong on every route, so resting would merely shrink the pool for the
retry. The approved 502/503/504-subset fix is the safe core of this rule;
the permanent form extends it to absent codes (a codeless post-accept
failure is still route-involved) while continuing to exclude 4xx. `http_error`
stays at 429-only: other pre-stream statuses either name no route (rest is
a no-op) or name an exhausted pool (404 → the `clearRests` path,
`providers.ts:1419-1450`, not a rest). **First-seen routes and models get
conservative defaults, not history**: `exclude: true` always (the one
documented-universal field); effort resolved per model against live
`supported_efforts` with fallback *omit the field* when the model omits
effort selection (Qwen today) or the value is unlisted (the 23 no-`low`
models), and `none` never sent when `mandatory` is true; the throughput
floor stays a deprioritizing preference, never a pin. **Where the defaults
live**: mechanism in code constants (`ROUTE_COOLDOWN_MS`,
`MAX_RESTING_ROUTES`, `providers.ts:1164-1172` — process behaviour, not
policy); per-call needs on `CompletionRequest` beside the existing
`preferredMinThroughput` (`providers.ts:87`) and `preferredBinding`
(`providers.ts:48`) — i.e. a future `reasoningEffort` override field, with
the global default as one code constant; account-level identity
(provider/model/key) stays on `LlmConfig` (`providers.ts:31-37`), which
gains nothing. A per-model effort table is prohibited for the same reason
as a route catalogue: it is a label that goes stale — the lookup happens
at send time against the keyless `GET /api/v1/models` metadata, the way
declarations are read per model today (`openrouterDeclaredParameters`,
`providers.ts:1574-1583`).

## 10.3 How adaptivity stays comparable

The report records *configuration* per assessment but rests fire
*mid-assessment* and change routing under it. Current recording:
`provenance.researchSettings` =
`configured.conditions` (pipeline bundle/limits/readers,
`pipelines.ts:73-76,121-124`) + CLI `overrides` + `operationConcurrency` +
`modelRetryPolicy` + binding preferences + `extractionRouteSort:
"throughput"` + `extractionRouteThroughputFloorTps: 50` + planner flag
(`person-research-benchmark.mts:504-517`); per wire attempt, the operation
record carries `configuration: { binding, provider, model, logicalCall,
wireAttempt, retryDelayMilliseconds, preferredMinThroughput }` plus the
`modelBoundary` diagnostic and `recoveryStopped`
(`research.ts:684-699`), while rests themselves are process-wide and
deliberately shared across concurrent people
(`person-research-benchmark.mts:398-400`). Two holes follow. First,
`compareReports` notes every `researchSettings` key difference as a
condition change (`report.ts:317-322`) but `conditionsComparable`
(`report.ts:366-376`) does not include `researchSettings` at all — only
corpus, judge (provider/model/version), research model, mode, reference
versions, and completeness — so a rest-policy or reasoning change that
ships as code does not even leave a condition note, let alone flip
`comparable`. Second, a mid-assessment rest is reconstructible today only
by correlating a failure diagnostic in one attempt with a different route
serving the next; the effective `ignore` list actually sent is never
recorded. What must be recorded so two assessments stay comparable: (a) in
`researchSettings` — the reasoning object sent (`reasoningEffort`,
`reasoningExclude`), and a rest-policy descriptor (predicate version +
`ROUTE_COOLDOWN_MS` + `MAX_RESTING_ROUTES`); the schema already allows it
(`researchSettings: z.record(...)`, `packages/shared/src/person-benchmark.ts:589`);
(b) in each attempt's `configuration` — the effective `provider.ignore`
list sent on that wire attempt, the reasoning effort actually sent, and
the declaration outcome (`chosen` binding + ladder source: declared vs
lookup-failed `null`); the diagnostic is already there. With (a), a policy
change across assessments is a visible condition diff; with (b), a rest
firing inside one assessment is an auditable per-attempt routing delta
rather than a silent confound. No new judge, no measure change: recording
is additive fields only, and `compareReports` verdict logic is untouched —
until the team decides a `researchSettings` mismatch should flip
`comparable`, notes are the correct conservative behaviour.

## 10.4 Smallest change set: option 3 now, future-proofing staged

Invariant every change preserves: no loosened judge (`JUDGE_VERSION`
pinned, judge config untouched), no changed assessment measure (recovery
credit and verdict rules untouched), no static provider catalogue (no
provider/route/model names in code or config).

1. **PR1 — adaptive rest for `upstream_error` (the approved option 3).**
   Extend the `routeFailed` predicate in `restFailedRoute`
   (`providers.ts:1207-1214`) to rest `upstream_error` with absent-or-≥500
   code; keep the one same-binding retry exactly as is
   (`providers.ts:1349-1354`). One predicate + tests driving each
   classification through `restFailedRoute`. Delivers §9.4-3 now and is the
   core of the §10.2 rule.
2. **PR2 — record conditions before changing requests.** Add the §10.3(a)
   `researchSettings` keys and §10.3(b) per-attempt `configuration` fields
   (additive; schema already permits the former). Must land before PR3 so
   the reasoning change is born recorded. Proves itself: re-run any saved
   report through `--compare` — verdict logic unchanged, new keys appear as
   condition notes.
3. **PR3 — conservative reasoning send.** `exclude: true` on every
   OpenRouter body built by `chatCompletionBody` (`providers.ts:1104-1142`)
   + effort resolved per model against `supported_efforts` (omit when
   unlisted/omitted; never `none` when `mandatory`), defaulting to `low`
   via one code constant with a `CompletionRequest` override. §1-8's
   recommendation, hardened for the 23 no-`low` models found in §10.1-3.
4. **PR4 — read the stable signal.** Classify (and rest/retry) off
   `error.metadata.error_type` where present
   (`provider_overloaded`/`provider_unavailable` → rest + retry;
   `invalid_request`/`content_policy_violation`/`refusal` → neither),
   numeric codes as fallback; honour `Retry-After` on 429/503. Keeps the
   shape-only diagnostic contract (codes/keys/counts, never message text —
   `failure.ts:201-221,237-257`).

Order is dependency order and each PR ships alone: PR1 fixes the measured
double-502 burn; PR2 makes PR3's effect comparable; PR3 cuts the thinking
mass behind `request_timeout`/`answer_overrun`; PR4 retires the numeric-code
shadow before it collides with a future `error_type`.
