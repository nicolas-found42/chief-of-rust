# Structured-extraction determinism — research findings

_Researched 2026-09-03 against the repo sources listed in §8 plus the primary sources cited inline. No code was changed. Companion tone/format reference: [debrief-eval-cli.md](debrief-eval-cli.md)._

## TL;DR — lever map

Every lever below is tagged **(P) prompt-only**, **(R) request-param / seam** (implementable today in `apps/server/src/llm/providers.ts` via OpenRouter), or **(C) code post-processing**. Effort is S (hours), M (a day or two), L (a week+). "Determinism" = same transcript → same extraction; "quality" = golden-score correctness.

| # | Lever | Cat | Effort | Determinism effect | Quality effect |
|---|-------|-----|--------|--------------------|----------------|
| 1a | `temperature: 0` on extraction calls | (R) | S | Medium — narrows sampling, does not guarantee identity (§1) | Neutral to slightly positive (fewer creative extras) |
| 1b | Fixed `seed` per transcript (e.g. hash of transcript id) + log `system_fingerprint` | (R) | S | Low-medium — "mostly identical" only when fingerprint matches; OpenRouter load-balancing defeats it unless pinned (§1–2) | Neutral; enables before/after comparisons |
| 2 | Pin one upstream: `provider: { order: ["<slug>"], allow_fallbacks: false }` (or `only`) | (R) | S | High — removes the largest nondeterminism source: per-request upstream switching (§2) | Risk: pinned upstream outages hard-fail; keep fallback allowlist for prod |
| 3 | Keep `response_format` + `strict: true` + `require_parameters: true`; treat schema as shape-guarantee only, never content-guarantee | (R) | S (already built) | Medium — eliminates malformed-JSON variance class entirely | Neutral on content; stops wasted retries on shape |
| 5a | Per-field definitions + few-shot `<example>` pairs + explicit exclusion rules in system prompt | (P) | S–M | Medium — strongest prompt-side variance reducer, esp. for owner/dueDate/guard classes | High — directly targets all five observed failure classes |
| 5b | Reasoning-before-JSON (extract-then-format; OpenAI `steps`+`final_answer` pattern) | (P) | M | Low (more tokens = more sampling surface) | Medium-high on long transcripts (empty/degenerate arrays) |
| 6 | Bounded repair re-ask carrying validator failure list (`max_retries` pattern, fits `MAX_EXTRACT_ATTEMPTS=3`) | (C) | S–M | Medium — converts invalid/degenerate outputs into valid ones deterministically | High — second attempt with error context fixes most schema/ceiling violations |
| 7a | Date normalization against the Date reference line (code, not model arithmetic) | (C) | S | High for dueDate class — copy becomes lookup | High — kills invented dates |
| 7b | Owner resolution against roster + mention ids (already `resolveActionItemOwners`; extend with fuzzy/surface-name match) | (C) | S–M | High for owner-null/wrong-person class | High |
| 7c | Dedup/merge near-duplicate array items (containment heuristic) + enforce per-golden ceilings in code | (C) | S | High for overproduction class | Medium (ceilings need care to not clip recall) |
| 4 | Grammar-constrained decoding (Outlines / XGrammar) | — | L / not applicable | Would be total for shape | N/A — needs local inference, not API access |

Recommended order: 7a + 7c (S, deterministic wins in code) → 5a (prompt hardening) → 2 (pin upstream for evals at minimum) → 1a/1b (cheap params) → 6 (repair loop) → 5b (if long-transcript empties persist).

## 1. Question

How do we make the meeting-debrief extraction pipeline — TypeScript/Bun server, custom OpenRouter SSE seam (`apps/server/src/llm/providers.ts`: `postSseStream`, `requestTimeoutOrTransport`, `promptOnlySystem`), structured output via OpenRouter `response_format` JSON-schema binding with `require_parameters: true` for models that declare support, extraction prompt (`DEBRIEF_SYSTEM_PROMPT` in `apps/server/src/modules/meeting-debrief/extraction.ts`) producing `decisions`, `actionItems` (title/owner/ownerMentionId/dueDate), `openQuestions`, `suggestedRecipients`, plus `summary`/`effectivenessEvidence`/`coachingAdvice`, identity context with mention ids, and a `dateReferenceLine` (meeting day + next 7 days) — more deterministic and higher-quality? Observed failure classes: (a) empty/degenerate array outputs on long transcripts; (b) owner nulls or wrong-person picks; (c) dueDate invention/miss; (d) overproduction past per-golden ceilings; (e) guard violations (listing work already done). Served models: `upstage/solar-pro4` (gate), `nex-agi/nex-n2-mini` (declares `response_format`/`structured_outputs`/`tools`/`reasoning`/`include_reasoning`), `inclusionai/ling-3.0-flash`.

## 2. Findings — how the seam works today

`makeCompleteJson(cfg, mockResultPath)` returns a per-request `CompleteJson` closure (`apps/server/src/llm/providers.ts:739-762`); the OpenRouter arm posts to `https://openrouter.ai/api/v1/chat/completions` with `Bearer` auth (`apps/server/src/llm/providers.ts:857-873`). Binding selection is per call from the model's declared `supported_parameters` (`declaredBinding`, `apps/server/src/llm/providers.ts:848-855`): `response_format` → `forced_tool_call` → `prompt_only`, stepping down one step per 4xx refusal only when the declaration is unreadable (`apps/server/src/llm/providers.ts:738-769`). When a binding is declared, the seam sends `provider: { require_parameters: true }` to hold routing to endpoints declaring everything the body sends (`apps/server/src/llm/providers.ts:753-755`).

The request body today carries **no sampling parameters at all**: `chatCompletionBody` sends only `model`, `messages`, and the binding (`response_format` as `{ type: "json_schema", json_schema: { name: "extraction_result", strict: true, schema } }`, or `tools` + forced `tool_choice`) (`apps/server/src/llm/providers.ts:684-721`). So `temperature`/`seed` currently fall through to each upstream's defaults — and, per §3 below, to *different* upstreams per request.

## 3. Answer

### 3.1 Sampling determinism: `temperature`, `seed`, `system_fingerprint`

**OpenAI official semantics.** The Chat Completions API documents `temperature` (0–2, lower = more predictable) and `seed` (integer; "If specified, our system will make a best effort to sample deterministically, such that repeated requests with the same seed and parameters should return the same result. Determinism is not guaranteed") plus a `system_fingerprint` response field identifying "the backend configuration that the model runs with" — the cookbook's rule is exact: "If the `seed`, request parameters, and `system_fingerprint` all match across your requests, then model outputs will mostly be identical. There is a small chance that responses differ even when request parameters and `system_fingerprint` match, due to the inherent non-determinism of our models" (`seed` + `system_fingerprint` definitions and the "mostly deterministic" rule).

- Sources: https://developers.openai.com/cookbook/examples/reproducible_outputs_with_the_seed_parameter (seed/system_fingerprint semantics, worked fixed-seed + `temperature: 0` example); https://platform.openai.com/docs/api-reference/chat/create (temperature/seed parameter definitions).

**What this means for us.** `temperature: 0` + fixed `seed` is worth sending (one-line seam change, §3.1 snippet), but OpenAI itself only promises "mostly identical" — and that promise is conditional on the fingerprint matching, which we cannot hold constant through OpenRouter (§3.2). Treat seed as a variance reducer and an experiment-control tool (same seed → comparable eval runs), never as a determinism guarantee.

**What OpenRouter forwards.** OpenRouter's parameters page lists `temperature` ("At 0, the model always gives the same response for a given input") and `seed` ("If specified, the inferencing will sample deterministically, such that repeated requests with the same seed and parameters should return the same result. Determinism is not guaranteed for some models") as forwarded sampling parameters, with a critical routing note: "When a sampling parameter is absent from your request, OpenRouter omits it upstream rather than substituting a hardcoded value, so the provider applies its own default… Explicitly sending it (e.g. `temperature: 1.0`) is still forwarded and may differ from omitting it".

- Source: https://openrouter.ai/docs/api-reference/parameters (temperature/seed/forwarding semantics).

**OpenRouter's documented nondeterminism.** By default OpenRouter load-balances each request across the top providers for a model slug: "requests are load balanced across the top providers to maximize uptime… Prioritize providers that have not seen significant outages in the last 30 seconds… look at the lowest-cost candidates and select one weighted by inverse square of the price… Use the remaining providers as fallbacks." Two identical extraction calls can therefore land on different physical upstreams (different weights, quantizations, structured-output implementations) — seed or no seed.

- Source: https://openrouter.ai/docs/guides/routing/provider-selection ("Price-Based Load Balancing (Default Strategy)"; "If you have `sort` or `order` set in your provider preferences, load balancing will be disabled").

Copy-adaptable snippet (seam: extend `chatCompletionBody`'s body for extraction calls):

```ts
body.temperature = 0;
body.seed = 42; // or a stable hash of the transcript id for per-input experiment control
```

And log the response's `system_fingerprint` (OpenAI-family upstreams return it) alongside each eval run so fingerprint drift is visible when identical-seed outputs diverge.

### 3.2 Provider pinning on OpenRouter

The same provider-routing page documents the `provider` request object: `order` ("List of provider slugs to try in order"), `allow_fallbacks` (default `true`; "Whether to allow backup providers when the primary is unavailable"), `only` ("List of provider slugs to allow"), `ignore`, plus `sort`/`require_parameters` and others. Pinning is explicit: "If you don't want to allow any other providers, you should disable fallbacks as well" — i.e. `order` alone still falls back; `order` + `allow_fallbacks: false` pins.

- Source: https://openrouter.ai/docs/guides/routing/provider-selection (`provider` object field table; "Ordering Specific Providers"; "Disabling fallbacks" — "Here's an example with `allow_fallbacks` set to `false`… and then fails if [the named provider] fails").

Copy-adaptable snippet (seam: merge into the existing `body.provider` alongside `require_parameters`):

```ts
body.provider = {
  require_parameters: true,          // existing: hold routing to capable endpoints
  order: ["together"],               // exact slug from the model's OpenRouter page (copy button)
  allow_fallbacks: false,            // pin: fail loudly rather than silently switching upstream
};
// Less strict alternative: { order: ["together", "fireworks"], allow_fallbacks: true }
```

Practical guidance for this repo: pin at least for eval runs (`run-debrief-eval` / gate), so scores compare prompts rather than upstream lotteries; for production, prefer `order` with 1–2 named upstreams and fallbacks left on, since `allow_fallbacks: false` converts an upstream outage into a user-visible failure. Note the seam already sets `require_parameters: true` only when the declaration is readable (`apps/server/src/llm/providers.ts:753-755`) — keep that condition; pinning composes with it.

### 3.3 Structured-output guarantees: OpenAI `strict` and OpenRouter passthrough

**OpenAI: what `strict` guarantees and does NOT.** Structured Outputs "ensures the model will always generate responses that adhere to your supplied JSON Schema, so you don't need to worry about the model omitting a required key, or hallucinating an invalid enum value" — benefits listed as "Reliable type-safety… Explicit refusals: Safety-based model refusals are now programmatically detectable… Simpler prompting". That is a **shape** guarantee (keys present, types/enums conform), not a **content** guarantee (the values can still be wrong, empty arrays are schema-valid, invented dates pass). Two further limits straight from the docs: (a) refusals remain possible — the API surfaces them explicitly (a `refusal` field on the message) instead of forcing schema-shaped text, so callers must handle `refusal` as a distinct outcome; (b) only a subset of JSON Schema is supported ("Adheres to schema… (see supported schemas)"), and `strict: true` schemas must declare `required` for every property with `additionalProperties: false` — unsupported keywords cause rejection, which is exactly the 4xx class our step-down ladder (`refusesBinding`, `apps/server/src/llm/providers.ts:772-781`) already handles.

- Source: https://platform.openai.com/docs/guides/structured-outputs (benefits/refusals; Structured-Outputs-vs-JSON-mode table incl. "supported schemas"; chain-of-thought structured example used in §3.5).

**OpenRouter: passthrough with per-endpoint support.** OpenRouter "supports structured outputs for compatible models" via the same `response_format: { type: "json_schema", … }` shape; "Support is determined per endpoint, not just per model: the same model may be served by multiple providers, and only some of those providers may support structured outputs." The doc prescribes our seam's exact behavior: "Set `require_parameters: true` in your provider preferences" so the request "is only routed to endpoints that support structured outputs". And the honesty clause: "Use strict mode… Enforcement varies by provider: some guarantee schema-conforming output, while others translate your schema into their own structured-output format or treat it as a strong hint, so exact compliance is not guaranteed on every endpoint."

- Source: https://openrouter.ai/docs/guides/features/structured-outputs (Overview, Using, Model Support, Best Practices).

**Reading for our failure classes.** `strict: true` + `require_parameters: true` (already the seam default for declaring models) eliminates the malformed-JSON variance class — keep it. It does nothing for empty arrays, wrong owners, invented dates, overproduction, or guard violations: all are schema-valid. Those need prompt (§3.5), repair (§3.6), and code (§3.7) levers. Also note the `nex-agi/nex-n2-mini` declaration (`structured_outputs` + `tools` + `reasoning`) routes it to the strictest binding already; `upstage/solar-pro4` and `inclusionai/ling-3.0-flash` get whatever they declare, stepping down only when the declaration is unreadable.

### 3.4 Constrained decoding: Outlines and XGrammar (one paragraph)

Grammar-constrained decoding (Outlines' `model(prompt, output_type)` finite-state/logits-masking approach — https://github.com/dottxt-ai/outlines; XGrammar's "efficient, flexible, and portable structured generation… ensure 100% structural correctness of the output… default structured generation backend for most LLM inference engines, including vLLM, SGLang, TensorRT-LLM, MLC-LLM" — https://github.com/mlc-ai/xgrammar, technical report https://arxiv.org/abs/2411.15100) is a hard schema guarantee enforced token-by-token inside the sampler. Stated plainly as contracted: it needs local inference (model weights loaded into an engine you control), not API access — no hosted provider in this pipeline (OpenRouter upstreams included) exposes a grammar knob, so this is not an actionable lever for the current architecture, only context for what "guarantee" would actually require.

### 3.5 Prompt patterns for extraction (first-party guidance + snippets)

**The base pattern (OpenAI cookbook).** OpenAI's extraction recipe is: short system instruction ("Extract the event information.") + user content + schema with per-property `description`s guiding the model, e.g. `location: { type: "string", description: "City or location name" }` — descriptions are doing extraction work, not just documentation. `DEBRIEF_SYSTEM_PROMPT` already follows this shape at larger scale (per-field definitions for every array, `apps/server/src/modules/meeting-debrief/extraction.ts:16-97`); the gap is not the pattern but its completeness for the five failure classes (see snippets).

- Source: https://platform.openai.com/docs/guides/structured-outputs (top-of-page extraction example: CalendarEvent schema with descriptions); https://openrouter.ai/docs/guides/features/structured-outputs ("Include descriptions: Add clear descriptions to your schema properties to guide the model").

**Forced tool choice (Anthropic).** Anthropic documents `tool_choice` control including forcing a specific tool: the tool-use overview round-trips `tool_choice` (`auto`, single-tool, and disable-parallel variants) and the structured-outputs page adds strict tool use (`strict: true`: "Guarantee schema validation on tool names and inputs"). Our seam's `forced_tool_call` binding (`tools: [save_extraction]` + `tool_choice` naming it, `apps/server/src/llm/providers.ts:707-719`) is this pattern; on OpenRouter it is the strictest available binding for models that declare `tools`/`tool_choice` but not `response_format`.

- Sources: https://docs.anthropic.com/en/docs/build-with-claude/tool-use (tool_choice: auto/any/none/specific-tool; disable_parallel_tool_use); https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs ("Strict tool use… Guarantee schema validation").

**Prefilling to force JSON (Anthropic).** Anthropic documents prefilling Claude's response — seeding the assistant turn with a prefix such as `{` — to constrain the opening tokens toward JSON. It is a soft constraint (prompt-level, not sampler-level) and composes with, but does not replace, schema bindings. Not currently needed in the seam (both active bindings already constrain shape), but it is the cheapest fallback-shape lever if a future model supports neither binding: prepend the JSON opening to the expected answer channel.

- Source: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/prefill-claudes-response.

**Examples: placement and form (Anthropic + OpenAI).** Anthropic's prompting best-practices prescribe 3–5 examples, relevant and diverse (cover edge cases), wrapped in `<example>`/`</example>` tags (multi-shot inside `<examples>`), so the model can distinguish examples from instructions; OpenAI's examples consistently place the task instruction in the system message and the content to extract in the user message. Neither vendor mandates system-vs-user placement for few-shots specifically — the load-bearing rules are relevance, diversity, and tagging. Our prompt already uses `<trusted-context>` / `<transcript>` XML structuring in the user message (`apps/server/src/modules/meeting-debrief/extraction.ts:142-186`), which matches Anthropic's "wrap each type of content in its own tag" guidance.

- Source: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices ("Use examples effectively": relevant/diverse/structured, 3–5 examples; "Structure prompts with XML tags").

**Reasoning-before-JSON vs direct JSON.** Two converging sources say: let the model reason before it commits to the constrained output. (a) Tam et al., "Let Me Speak Freely?" (arXiv 2408.02442): "we observe a significant decline in LLMs reasoning abilities under format restrictions… stricter format constraints generally lead to greater performance degradation in reasoning tasks" — direct-to-schema generation measurably costs reasoning quality. (b) OpenAI's own structured-outputs guide ships a chain-of-thought pattern as a first-class example: a `steps: [{ explanation, output }]` array plus `final_answer`, i.e. reasoning slots *inside* the schema. Anthropic's prompting guide likewise treats thinking/reasoning as the lever for multi-step correctness ("Leverage thinking and interleaved thinking capabilities"). For long transcripts (failure class (a): empty/degenerate arrays), the actionable form is an extract-then-format instruction or schema: per-array "evidence first, then item" ordering, or a `reasoning`/`notes` string field per array that the model must fill before the items — cheap models in particular do better when the recall work has somewhere to go before the constrained arrays.

- Sources: https://arxiv.org/abs/2408.02442 (abstract + §1 finding quoted above); https://platform.openai.com/docs/guides/structured-outputs (chain-of-thought math-tutoring example: `steps` + `final_answer` schema); https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices (thinking capabilities section).

**Copy-adaptable prompt snippets** (each maps to a failure class; style matches the existing prompt's imperative voice):

Per-field definition tightening (owner class (b) — the current prompt already has the core rule at `extraction.ts:48-56`; add the tie-break the goldens punish):

```text
- "owner": the one person who will do the work, as named in the transcript. …
  Tie-breaks, in order: (1) the person explicitly told to do it ("you should…",
  "can you…", "please…"); (2) the person who said "I will…"; (3) null.
  A speaker reporting someone else's commitment ("she said she'd…") does not
  own it. When two names appear, quote the owning phrase in "evidence".
```

Few-shot example pair (guard class (e) + exclusion class; wrap in `<examples>` per Anthropic form):

```text
<examples>
<example>
Transcript: "Could you give me access to the dashboard?" / "I just sent you
the link — check now." / "Got it, thanks."
actionItems: [] — the request was fulfilled during the meeting; fulfilled work
is never a commitment.
</example>
<example>
Transcript: "Priya, can you send the timeline by Friday?" / "Yes, I'll send
it tomorrow."
actionItems: [{"title": "Send the timeline to the team", "owner": "Priya",
"ownerMentionId": "id=<matching id or null>", "dueDate": "<tomorrow's line
from the Date reference>"}] — the person told owns it, not the speaker.
</example>
</examples>
```

Explicit exclusion + ceiling rules (classes (d), (e)):

```text
Exclusions (never emit): work fulfilled or superseded during the meeting,
banter, ideas floated but never agreed to, decision restatements inside
actionItems, attendees/speakers/roster members inside suggestedRecipients.
Ceilings: at most 8 actionItems, 6 decisions, 6 openQuestions — if you exceed
a ceiling, merge the two weakest near-duplicates until you fit.
```

Reasoning-before-JSON (class (a); schema-level variant of the OpenAI steps pattern):

```text
Before filling each array, write one private sentence per array in a
"reasoning" field: what you scanned for and what you found. Fill the arrays
only after the reasoning sentence. (Schema: add "reasoning": { decisions,
actions, questions } free-text slots consumed before the arrays.)
```

### 3.6 Validation-and-repair loops

**The instructor pattern.** Instructor (jxnl/instructor) frames validation + re-ask as one loop: "Validation Flow: Define Pydantic Model → Send Request → Validate → valid ? return : re-ask with error context → validate again → max retries ? raise" — and the re-ask message format is explicit in their source walkthrough: append the previous assistant message, then a user message `"Please correct the function call; errors encountered:\n{e}"` where `{e}` is the validator's failure list, bounded by `max_retries` (`client.create(response_model=…, max_retries=2, …)`). Their validation docs add the two extensions that matter for us: rule validators (`@field_validator`, e.g. quote-must-be-substring) and `context=` passing runtime data (source text, rosters, calendars) into validators via `ValidationInfo`.

- Sources: https://python.useinstructor.com/concepts/reask_validation/ (flow; "Using Reasking Logic to Correct Outputs"; behind-the-scenes message-append snippet; context-based QuoteExtraction example); https://python.useinstructor.com/concepts/validation/ (flow diagram, field/custom validators); https://python.useinstructor.com/concepts/retrying/ (`max_retries`, error-specific retries, token-budget bounding).

**OpenAI refusal handling.** Refusals are a distinct, detectable outcome — not a schema violation to retry blindly. OpenAI's guide lists "Explicit refusals" as a Structured Outputs feature ("Safety-based model refusals are now programmatically detectable"); the correct handling is: detect `refusal`, do not count it against the repair budget the same way as a correctable validation failure (a refusal re-asked identically usually refuses again — change the input or route, don't just retry).

- Source: https://platform.openai.com/docs/guides/structured-outputs (benefits list: "Explicit refusals").

**TypeScript sketch for our seam** (fits `MAX_EXTRACT_ATTEMPTS=3` at module level; Zod plays instructor's Pydantic role, `safeParse` issue list plays the `{e}` failure list):

```ts
import { MeetingDebriefExtractionSchema } from "@chief-of-staff-demo/shared";

const MAX_REPAIR_ATTEMPTS = 2; // module-level budget stays 3 total: 1 initial + 2 repairs
async function extractWithRepair(system: string, user: string, complete: CompleteJson) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let raw = await complete({ system, user, schema: MeetingDebriefExtractionSchema });
  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
    const parsed = MeetingDebriefExtractionSchema.safeParse(raw);
    // + semantic validators: evidence-is-substring, owner-in-roster,
    //   dueDate-in-reference-lines, array ceilings (collect as strings)
    const failures: string[] = zodIssues(parsed).concat(semanticChecks(raw, { transcript, roster, dateLines }));
    if (failures.length === 0) return parsed.data;
    if (isRefusal(raw)) return null; // refusals don't repair by re-asking identically
    const repairUser =
      `Your previous output failed validation. Fix ONLY the listed problems; ` +
      `keep every valid item byte-identical.\nProblems:\n- ${failures.join("\n- ")}`;
    raw = await complete({ system, user: `${user}\n\n${repairUser}`, schema: MeetingDebriefExtractionSchema });
  }
  return MeetingDebriefExtractionSchema.safeParse(raw).data ?? null;
}
```

Design notes from the sources: carry the *failure list* (not just "try again"), keep valid items frozen (prevents repair from rewriting good content into new errors), bound the loop (instructor's `max_retries`; our module ceiling), and exempt refusals. Semantic checks worth including in `failures`: evidence-quote substring misses (instructor's QuoteExtraction pattern), owner names absent from transcript/roster, dueDates absent from the Date reference lines, arrays over ceiling, and empty-array-with-evidence-in-summary contradictions (the prompt's §"prove it to yourself" rule, made checkable).

### 3.7 Post-processing determinism in code

The pattern sources all agree on the layering: schema gets you shape; *code* gets you truth. Instructor validates against runtime context (`context={"source_text": …}` + `ValidationInfo` — the validator, not the model, is the authority on membership); Anthropic's long-context guidance says "Ground responses in quotes: ask Claude to quote relevant parts of the documents first" (evidence-before-claim, already our `evidence` field); OpenAI's extraction recipe puts the disambiguating facts in `description`s and expects the caller to own the rest. The three normalizers below are therefore *our* heuristics (as contracted), hung on first-party patterns:

- Sources: https://python.useinstructor.com/concepts/reask_validation/ (context-based validation: "The `context` parameter passes the source text to the validator"); https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices ("Ground responses in quotes"); https://platform.openai.com/docs/guides/structured-outputs (description-guided extraction).

**Date normalization (class (c)).** The prompt already tells the model to copy from the Date reference line instead of computing (`extraction.ts:59-65`, `dateReferenceLine` at `extraction.ts:103-116`). Make code the enforcer: after parse, check every `dueDate` for membership in the 8 emitted reference lines; on miss, attempt one normalization pass (parse `dueDate` as a date; if it falls within meeting-day…+7d, snap to the ISO string; else if the transcript contains a weekday name near the item's title/evidence, map via the reference lines); otherwise null it. Invented dates become `null` deterministically instead of golden-misses. Our heuristic; the *pattern* (validate against caller-owned context) is instructor's.

**Owner resolution (class (b)).** `resolveActionItemOwners` + `latestDecisionsByMention` (`extraction.ts:195-246`) already resolve mention ids against the Catalog review state and null the unknown — extend, don't replace: (1) exact surface-text match against mentions/roster; (2) same containment/dedup normalization as §3.7-dedup (case/whitespace/punctuation-folded contains-either-way); (3) null with the item kept (owner null + good title still scores; dropped item never does). Never promote a beneficiary ("…for Priya") — the prompt's rule, enforced by checking the owning phrase against directive verbs (`you|please|can you|will you`) vs beneficiary prepositions (`for <name>`).

**Dedup/merge + ceilings (class (d)) + guard strip (class (e)).** Near-duplicate merge: fold (lowercase, strip punctuation/owner-name prefix), then merge when one title contains the other or token-Jaccard ≥ 0.6, keeping the entry with the stronger evidence/owner. Ceilings in code (8 actions / 6 decisions / 6 questions, matching the prompt snippet in §3.5): weakest-first eviction (no owner + no dueDate + shortest evidence goes first). Guard strip: drop action items whose evidence/title matches fulfillment patterns adjacent in the transcript ("sent you", "done", "got it", "instead now") — `stripUnverifiedRecipientEmails` (`extraction.ts:254-267`) is the existing precedent for code-side verification against the transcript; extend the same idea to fulfilled-work detection.

## 4. What this means for the eval gate

The five failure classes map to levers as follows: (a) empties → reasoning-before-JSON (§3.5) + repair loop (§3.6, empty-with-evidence check); (b) owners → few-shot tie-breaks (§3.5) + code resolution (§3.7); (c) dueDates → Date-line membership enforcement in code (§3.7); (d) overproduction → prompt ceilings + code eviction (§3.5, §3.7); (e) guards → exclusion few-shots (§3.5) + fulfillment strip (§3.7). Sampling params (§3.1) and provider pinning (§3.2) don't fix any class directly — they make the *measurement* of fixes meaningful by removing upstream lottery from `eval:debrief` scores. Suggested sequencing for gate work: pin provider for evals first (so every subsequent prompt/code change measures cleanly), then 7a/7c, then 5a, then re-run the gate.

## 5. Open questions / non-goals

1. **Eval pinning vs prod pinning.** Pinning for `eval:debrief` is unambiguous win; prod pinning trades determinism for outage exposure. Undecided: one pinned upstream + fallbacks on, or full dynamic routing in prod.
2. **Seed stability across upstreams.** A fixed seed only reproduces on the same upstream + fingerprint; with fallbacks on, seed is experiment control, not determinism. Whether to hash seed from transcript id (per-input control) or fix globally is a minor eval-design choice.
3. **Reasoning-field schema cost.** Adding `reasoning` slots grows output tokens on every call (cost + latency) and needs golden/scorer tolerance (scorer reads only known arrays — verify extra keys don't break `RunFile` parsing before shipping).
4. **Ceiling values.** 8/6/6 ceilings are proposed, not measured — set from golden distributions before enforcing in code.
5. **Outlines/XGrammar.** Explicitly out of scope: no local-inference path exists in this architecture.

## 6. Sources — repo

- `apps/server/src/modules/meeting-debrief/extraction.ts` — `DEBRIEF_SYSTEM_PROMPT` (`:16-97`), `dateReferenceLine` (`:103-116`), `meetingDateLine` (`:123-131`), `buildDebriefMessages` (`:138-186`), `resolveActionItemOwners` / `latestDecisionsByMention` (`:195-246`), `stripUnverifiedRecipientEmails` (`:254-267`)
- `apps/server/src/llm/providers.ts` — `chatCompletionBody` (`:684-721`), step-down ladder (`:738-769`), `refusesBinding` (`:772-781`), declaration cache (`:788-803`), `declaredBinding` (`:848-855`), `openrouterComplete` (`:857-873`), `promptOnlySystem` (`:679-681`)
- `docs/research/debrief-eval-cli.md` — format reference; runner/scorer/seam background (§2)

## 7. Sources — primary (every load-bearing claim)

1. https://developers.openai.com/cookbook/examples/reproducible_outputs_with_the_seed_parameter — `seed`/`system_fingerprint` semantics ("mostly identical" rule), fixed-seed + `temperature: 0` worked example (§3.1)
2. https://platform.openai.com/docs/api-reference/chat/create — `temperature`/`seed` parameter definitions (§3.1)
3. https://openrouter.ai/docs/api-reference/parameters — forwarded sampling params (`temperature`, `seed`, "Determinism is not guaranteed for some models"), omitted-params-are-omitted-upstream rule (§3.1)
4. https://openrouter.ai/docs/guides/routing/provider-selection — default price-weighted load balancing across upstreams; `provider` object (`order`, `allow_fallbacks`, `only`, `require_parameters`); pinning requires disabling fallbacks (§3.1, §3.2)
5. https://platform.openai.com/docs/guides/structured-outputs — strict shape guarantee, explicit refusals, supported-schemas subset, chain-of-thought `steps`+`final_answer` example (§3.3, §3.5)
6. https://openrouter.ai/docs/guides/features/structured-outputs — passthrough, per-endpoint (not per-model) support, `require_parameters: true` prescription, "exact compliance is not guaranteed on every endpoint" (§3.3)
7. https://github.com/dottxt-ai/outlines — grammar-constrained generation via logits control (§3.4)
8. https://github.com/mlc-ai/xgrammar — "100% structural correctness", inference-engine backend (vLLM/SGLang/TensorRT-LLM/MLC-LLM) (§3.4)
9. https://arxiv.org/abs/2411.15100 — XGrammar technical report (§3.4)
10. https://arxiv.org/abs/2408.02442 — Tam et al., "Let Me Speak Freely?": format restrictions degrade reasoning; stricter → worse (§3.5)
11. https://docs.anthropic.com/en/docs/build-with-claude/tool-use — `tool_choice` (auto/specific-tool/disable-parallel) round-trip (§3.5)
12. https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs — strict tool use schema validation; JSON-output extraction example (§3.5)
13. https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/prefill-claudes-response — prefilling the assistant turn to constrain output opening (§3.5)
14. https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices — 3–5 relevant/diverse/tagged `<example>`s; XML structuring; quote-grounding; thinking capabilities (§3.5, §3.7)
15. https://python.useinstructor.com/concepts/reask_validation/ — validate → re-ask with `"Please correct the function call; errors encountered:\n{e}"` + `max_retries`; context-passed validators (QuoteExtraction) (§3.6, §3.7)
16. https://python.useinstructor.com/concepts/validation/ — Pydantic validation flow; field/custom validators (§3.6)
17. https://python.useinstructor.com/concepts/retrying/ — built-in `max_retries`, error-specific retries, token budgets (§3.6)
