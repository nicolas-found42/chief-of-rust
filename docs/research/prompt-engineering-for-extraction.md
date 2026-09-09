# Prompt engineering for extraction — research findings

_Researched 2026-09-04 against the primary sources cited inline. No code was changed. Consumer: the single template-literal system prompt (`DEBRIEF_SYSTEM_PROMPT` in `apps/server/src/modules/meeting-debrief/extraction.ts`) plus the trusted user-message context (Date reference line, roster, identity state), temperature 0, structured output via OpenRouter (`upstage/solar-pro4`). Companion notes: [structured-extraction-determinism.md](structured-extraction-determinism.md), [debrief-eval-cli.md](debrief-eval-cli.md)._

## TL;DR

For a mid-tier model doing single-call extraction, the evidence converges on seven moves: (1) a few **positive, diverse, tagged** exemplars drawn from your own transcripts — never prohibition examples; (2) extraction logic in the **schema's `description`s**, not just prose; (3) a **quote-first / evidence-before-claim** rule already half-built here; (4) **single-call per-bucket decomposition** via ordered sections, not multi-call pipelines; (5) a **copy-don't-compute date rule** against the Date reference line; (6) **owner tie-breaks phrased as positive selection order** plus roster-membership checks; (7) keeping the prompt **short enough for a mid-tier model** by cutting redundant rules, since long prompts measurably degrade mid-context recall. Ranked list in §8.

Failure classes referenced below: **(R) under-capture** (recall floors — empties/misses), **(P) over-capture** (unmatched ceilings — extras, restatements, fulfilled work), **(O) owner misattribution**, **(D) date misresolution**.

---

## 1. Few-shot exemplar selection — and why prohibition examples backfire

**What it is.** 2–5 short input→output demonstrations embedded in the system prompt, showing the model exactly what to extract and what to skip.

**What the sources actually say.**

- Anthropic's prompting best practices: examples are "one of the most reliable ways to steer output format, tone, and structure"; they must be **relevant** (mirror the actual use case), **diverse** (cover edge cases, vary enough the model doesn't pick up unintended patterns), and **structured** (wrapped in `<example>` tags, several inside `<examples>`); "Include 3–5 examples for best results." ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices))
- Google's Vertex AI prompting docs say the same with a sharper warning: "Use specific and varied examples to help the model narrow its focus" — but "always accompany few-shot examples with clear instructions. Without clear instructions, models might pick up on unintended patterns or relationships from the examples, which can lead to poor results." Google adds the overfitting bound: "too few examples are ineffective… Too many examples can cause the model to overfit." ([Include few-shot examples](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/few-shot-examples))
- Anthropic's long-context engineering study (a quantitative case study on recall, run on the smaller Claude Instant precisely because it "needs more help, which makes it easy to see when changes to prompting improve performance" — the closest published analogue to our mid-tier situation) found **contextual** examples (correctly answered questions about *other sections of the same document*) help at both 70K and 95K tokens and "more examples is better" — while **generic** examples on unrelated general knowledge "do not seem to help performance." ([Prompt engineering for Claude's long context window](https://www.anthropic.com/news/prompting-long-context))
- The prohibition-echo failure mode: Anthropic's current guidance is explicit — **"Tell Claude what to do instead of what not to do"**, e.g. prefer "Your response should be composed of smoothly flowing prose paragraphs" over "Do not use markdown in your response." The mechanism is the one Google names above: in-context learning mimics surface patterns, so a prohibition example containing the forbidden shape teaches the shape. ([Prompting best practices — "Control the format of responses"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices))

**Expected effect.** Recall ↑↑ (largest single-call lever for class **R**: exemplars showing *implicit* commitments — "I'll take a look at that" — teach the model the boundary it currently misses). Precision ↑ (class **P**: one exemplar showing fulfilled-work exclusion). Risk is asymmetric: prohibition exemplars ("here is work you must NOT extract: …") can *increase* the forbidden output by priming its surface form — always frame exclusions as positive selections (see example).

**Prompt phrasing example** (positive, diverse, tagged; adapted to this schema):

```text
<examples>
<example>
Transcript: "Priya, can you send the timeline by Friday?" / "Yes, I'll send it tomorrow."
actionItems: [{"title": "Send the timeline to the team", "owner": "Priya",
"dueDate": "<tomorrow's line from the Date reference>"}]
Why this item: the person told to do the work owns it, not the speaker.
</example>
<example>
Transcript: "Could you give me access to the dashboard?" / "I just sent you
the link — check now." / "Got it, thanks."
actionItems: []
Why empty: the request was fulfilled inside the meeting; fulfilled work is
never a commitment. Only unfulfilled forward-looking work qualifies.
</example>
</examples>
```

Note the second exemplar teaches the exclusion *without* showing a forbidden extraction object — the output is `[]` plus a positive rule ("Only unfulfilled forward-looking work qualifies").

---

## 2. Explicit output-schema anchoring vs prose rules

**What it is.** Putting the extraction contract in the JSON Schema itself — per-property `description`s, enums, `required`, `additionalProperties: false` — instead of (or as well as) prose paragraphs in the system prompt.

**What the sources actually say.**

- OpenAI's Structured Outputs guide: the feature "ensures the model will always generate responses that adhere to your supplied JSON Schema, so you don't need to worry about the model omitting a required key, or hallucinating an invalid enum value" — and its third listed benefit is **"Simpler prompting:** No need for strongly worded prompts to achieve consistent formatting." The guide's own extraction recipe is a short system instruction ("Extract the event information.") plus a schema whose properties carry the disambiguating content. ([Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs))
- Anthropic's Structured Outputs docs make the same shape-not-content split from the other side: constrained decoding guarantees "Always valid: No more `JSON.parse()` errors. Type safe: Guaranteed field types and required fields. Reliable: No retries needed for schema violations" — i.e. keys, types, enums. Nothing about values being *right*. ([Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs))
- Google's prompt-health checklist adds the failure pairing to avoid: **"Missing output format specification:** Avoid leaving the model to guess the structure of the output" — specify the format *and* "show the output structure in your few-shot examples." Schema + exemplars, not schema xor exemplars. ([Overview of prompting strategies — Prompt health checklist](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/prompt-design-strategies))

**Expected effect.** Recall ~neutral, precision ↑ on *shape* errors (missing keys, wrong types, invented enum values drop to ~zero under `strict: true`). Content classes (**R/O/D**) move only when the schema's `description`s do extraction work — e.g. an `owner` description stating the tie-break order outperforms the same words buried in prose, because the description is evaluated at the token position where the value is generated.

**Prompt phrasing example** (schema-anchored, not prose-only). Instead of a prose paragraph about owners, put it where the value is decided:

```json
"owner": {
  "type": ["string", "null"],
  "description": "The one person who will do the work, as named in the transcript. Select in this order: (1) the person explicitly told to ('you should', 'can you', 'please'); (2) the person who said 'I will'; (3) null. A beneficiary ('for Priya') is not the owner. Never a team or company."
}
```

Keep the prose rule too (defense in depth), but treat the description as the load-bearing copy: one sentence, positive selection order, no prohibitions without a positive restatement.

---

## 3. Self-verification / self-check instructions and their evidence

**What it is.** Instructing the model to re-read its own draft output against the source and fix inconsistencies before replying — the single-call version of a verify-then-repair loop. (The multi-call repair loop is covered in structured-extraction-determinism.md §3.6; this section is only about what fits *inside* one call.)

**What the sources actually say.**

- Dhuliawala et al., **Chain-of-Verification (CoVe)** (arXiv 2309.11495): the model "(i) drafts an initial response; then (ii) plans verification questions to fact-check its draft; (iii) answers those questions independently so the answers are not biased by other responses; and (iv) generates its final verified response." Result: "CoVe decreases hallucinations across a variety of tasks, from list-based questions from Wikidata, closed book MultiSpanQA and longform text generation." The load-bearing detail is step (iii): verification answers must be produced *independently* of the draft, or the model just re-confirms itself. ([arXiv 2309.11495](https://arxiv.org/abs/2309.11495))
- Madaan et al., **Self-Refine** (arXiv 2303.17651): a single LLM acts as generator, feedback-provider, and refiner iteratively with no extra training; "outputs generated with Self-Refine are preferred… over those generated with the same LLM using conventional one-step generation, improving by ~20% absolute on average in task performance" across 7 tasks. Caveat for us: that headline number is multi-iteration with full feedback passes — a single trailing "check your work" paragraph should be expected to capture a fraction of it. ([arXiv 2303.17651](https://arxiv.org/abs/2303.17651))
- Anthropic's long-context study gives the single-call form its empirical backing: **"Pulling relevant quotes into the scratchpad is helpful in all head-to-head comparisons"** — instructing the model to extract reference quotes relevant to the question *before* answering improved recall for the smaller model at both context lengths, "at a small cost to latency." ([Prompt engineering for Claude's long context window](https://www.anthropic.com/news/prompting-long-context))
- Anthropic's current best-practices page generalizes it: **"Ground responses in quotes:** For long document tasks, ask Claude to quote relevant parts of the documents first before carrying out its task. This helps Claude focus on the relevant content and ignore the rest." ([Prompting best practices — Long context prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices))

**Expected effect.** Recall ↑ (class **R**: the "re-read the transcript once per array" pass catches items the first pass walked past). Precision ↑↑ (class **P**: quote-grounding kills paraphrase-invented items, because an item with no verbatim quote must be deleted). Owner/date classes (**O/D**) improve only if the check names them explicitly — a generic "check your work" degrades into self-confirmation (the CoVe step-(iii) warning). Cost: more output tokens per call.

**Prompt phrasing example** (the current prompt's "Final self-check" already does most of this; the evidence-backed tightening is to make each check *falsifiable* — quote-bound — rather than advisory):

```text
Final self-check. Delete any item that fails its check — do not rewrite it:
1. Every actionItem's evidence is a verbatim transcript quote naming the
   commitment. No quote, no item.
2. Every owner appears in (or is the speaker of) that item's evidence quote.
3. Every dueDate's weekday word appears in that item's evidence quote and the
   date is copied digit-for-digit from the Date reference line.
4. Every summary sentence describing a choice, commitment, or open question
   has a matching item in its array.
```

This prompt already ships checks 1–4 in prose form (`extraction.ts:181-188`); the research says keep them, because quote-grounded self-check is the best-evidenced single-call accuracy lever available.

---

## 4. Decomposition (per-bucket extraction) in single-call settings

**What it is.** Splitting "extract decisions + action items + open questions + recipients" into separate sub-tasks — either across calls (multi-call pipeline) or as ordered sections inside one call.

**What the sources actually say.**

- Khot et al., **Decomposed Prompting (DecomP)** (arXiv 2210.02406): decomposing complex tasks into simpler sub-tasks delegated to dedicated prompts "outperform[s] prior work on few-shot prompting" — but every result in the paper is a *multi-call* system with routing between sub-task handlers. ([arXiv 2210.02406](https://arxiv.org/abs/2210.02406))
- Zhou et al., **Least-to-Most** (arXiv 2205.10625): "break down a complex problem into a series of simpler subproblems and then solve them in sequence. Solving each subproblem is facilitated by the answers to previously solved subproblems" — again sequential calls, with the headline (99% vs 16% on SCAN length-split) coming from sequential solving where later steps condition on earlier answers. ([arXiv 2205.10625](https://arxiv.org/abs/2205.10625))
- Google's Vertex AI guidance is the directly applicable source for the single-call case, and it cuts the other way: its prompt-health checklist flags **"Too many tasks:** If the prompt asks the model to perform several distinct cognitive actions in a single pass (for example, 1. Summarize, 2. Extract entities, 3. Translate, and 4. Draft an email), it is likely trying to accomplish too much. Break the requests into separate prompts." But the same page offers the in-between: **"Incorrect Chain of Thought (CoT) order:** Avoid providing examples that show the model generating its final, structured answer before it has completed its step-by-step reasoning" — i.e. *within* one call, reason first, structured answer second. ([Overview of prompting strategies](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/prompt-design-strategies)) Google's companion page documents both multi-call shapes (chained prompts, parallel-per-bucket "aggregate responses") for when one call is not enough. ([Break down complex tasks](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/break-down-prompts))

**Expected effect.** Single-call ordered sections: recall ↑ (class **R**) — forcing a per-bucket scan ("re-read the transcript once per array") counters the model's tendency to stop after the first buckets fill. A full multi-call per-bucket pipeline would likely gain more (that is what DecomP/least-to-most measure), but none of the cited papers test single-call sectioning, so size the expectation as modest. The honest statement: **no evidence reviewed supports multi-call pipelines as necessary here** — the failures are boundary judgments (is this a commitment? who owns it? which day?), not sub-tasks with clean interfaces, and the current single call already produces all buckets.

**Prompt phrasing example** (ordered single-call decomposition with cross-bucket dedup as the sequencing payoff — later buckets condition on earlier ones, the least-to-most insight in miniature):

```text
Extract in this order, one bucket at a time. Do not start the next bucket
until the previous one is complete:
1. actionItems (commitments are the easiest to confuse — claim them first).
2. decisions (never a sentence that assigns work to a named person; if it
   does, it already belongs to bucket 1, not here).
3. openQuestions (never an item settled by a bucket-1 or bucket-2 entry).
One fact appears exactly once in the whole reply: if a later bucket restates
an earlier item, delete the later one.
```

---

## 5. Date / relative-time normalization guidance patterns

**What it is.** Converting "tomorrow", "Friday", "for Monday's demo" into `YYYY-MM-DD` against a known meeting date.

**What the sources actually say.**

- Gautam, Lange & Strötgen, **Discourse-Aware In-Context Learning for Temporal Expression Normalization** (arXiv 2404.07775): LLMs can do temporal-expression normalization via in-context learning when the prompt injects "task, document, and example information"; their window-based design resolves "relative and incomplete temporal expressions within a given context," and "dynamically including relevant examples during inference" gives large gains in non-standard settings. Two transferable points: the model needs the *document date in the prompt* (not in weights) and examples of relative→absolute mappings. ([arXiv 2407.07775](https://arxiv.org/abs/2404.07775))
- The rule-based prior art is Stanford **SUTime**: "Recognized temporal expressions can be resolved relative to the document date. For instance, the expression *this Wednesday* will be resolved to the Wednesday" of/around the document date. The pattern — anchor date + weekday-name matching + copy — predates LLMs and is exactly what the current Date reference line reimplements for the model. ([SUTime — Stanford CoreNLP](https://stanfordnlp.github.io/CoreNLP/sutime.html))
- Google's component model of prompts lists **Context** ("any information that the model needs to refer to… background, documents, input data") as a first-class prompt component and prescribes a **Recap** — "concise repeat of the key points of the prompt, especially the constraints and response format, at the end." Both apply to dates: the anchor calendar must be *in* the prompt, and the copy rule restated at the end. ([Overview of prompting strategies](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/prompt-design-strategies))

**Expected effect.** Class **D** specifically: recall ↑ (fewer nulls where the transcript names a day) and precision ↑ (fewer invented/extrapolated dates). The evidence direction is unanimous — *copy from a provided calendar, never compute* — because weekday arithmetic is a known small-model failure (cf. Anthropic's eval-building note that token-seeing models stumble on counting/arithmetic-style questions; the current code comment says it outright: "cheap models cannot" do calendar arithmetic).

**Prompt phrasing example** (this is already the strongest part of the current prompt at `extraction.ts:107-128`; the research-backed minimal form):

```text
"dueDate": a deadline ONLY if stated or clearly implied, as YYYY-MM-DD.
Never compute a date. The trusted context lists the meeting day and the next
7 days with weekday names: find the line whose weekday matches the day the
transcript ties to THIS work, then copy that line's date digit-for-digit.
"Today" is the meeting day; "tomorrow" is the next line. A vague deadline
with no day ("end of the week", "in a couple of days") is null. If the day
is further out than the list reaches, write null — never extrapolate.
```

Keep also the falsifiable check from §3 ("every dueDate's weekday word appears in that item's evidence quote") — Gautam et al.'s "resolve within the given context" becomes enforceable only when the date must be traceable to the item's own quote.

---

## 6. Owner / attribute assignment patterns (name, never role)

**What it is.** Forcing the `owner` (and `raisedBy`) value to be a transcript surface name bound to a commitment moment — not a role ("the facilitator"), team, beneficiary, or the dictating voice.

**What the sources actually say.**

- No vendor doc was found prescribing "name vs role" for extraction attribution; the pattern below is composed from three converging sources (marked [INFERENCE] where composed):
  1. OpenAI's schema-description pattern (§2): the tie-break belongs in the property `description`, evaluated where the value is generated.
  2. Anthropic's quote-grounding rule (§3): the owner must be checkable against the item's evidence quote — attribution without a quote is what CoVe's verification step exists to delete.
  3. The fulfilment/beneficiary confusion ("send Adejoke the link so she can reinstall" — the item is *her* reinstall, owned by her, not the sender) is a directive-vs-beneficiary syntax judgment; phrasing it as a positive selection order (told → promised → null) follows Anthropic's "tell what to do" rule (§1) rather than a list of "never attribute to…" prohibitions.
- Supporting mechanism from Google: few-shot exemplars "regulate… scoping" of responses ([few-shot examples](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/few-shot-examples)) — one exemplar where the speaker differs from the owner (dictated list, "you should…", third-party "Erin will…") teaches the scope better than any abstract rule.

**Expected effect.** Class **O** specifically: misattribution ↓ (speaker-default and beneficiary errors), with a small recall cost if the rule is too strict (items dropped for lack of a clean owner — hence "null is rare but legal," and code-side resolution keeps the item with `owner: null`).

**Prompt phrasing example:**

```text
"owner": the one PERSON who will do the work, as named in the transcript.
Select in this order: (1) the person explicitly told to do it ("you should",
"can you", "please"); (2) the person who said "I will"; (3) null. A sentence
reporting someone else's pledge ("she said she'd do it") belongs to the
pledger. A title's beneficiary ("...for Priya") is not the owner — check who
does the work. After writing it, check the name appears in (or is the speaker
of) this item's evidence quote.
```

Pair with one exemplar where owner ≠ speaker (the Priya example in §1). The roster/identity context then does the rest in code (`resolveActionItemOwners`), not in the prompt: the prompt binds surface name → quote; code binds surface name → mention id.

---

## 7. Output length vs instruction-following degradation (long prompts, mid-tier models)

**What it is.** The finding that stuffing more instructions, buckets, and edge-case rules into one prompt can *reduce* compliance — especially for smaller models and mid-prompt content.

**What the sources actually say.**

- Liu et al., **Lost in the Middle** (arXiv 2307.03172): "performance can degrade significantly when changing the position of relevant information… performance is often highest when relevant information occurs at the beginning or end of the input context, and significantly degrades when models must access relevant information in the middle of long contexts, even for explicitly long-context models." Measured on multi-document QA and key-value retrieval. ([arXiv 2307.03172](https://arxiv.org/abs/2307.03172))
- Anthropic's long-context study replicates the positional effect and adds the prompt-design consequence: examples added to the prompt "increase[] the distance between the very end of the document…and when [the model] needs to answer," which *degraded* end-of-document recall — "this… emphasize[s] the importance of putting the instructions at the end of the prompt." Takeaway: order is load-bearing — long data first, query/instructions/examples positioned so the answering instruction is last. ([Prompt engineering for Claude's long context window](https://www.anthropic.com/news/prompting-long-context))
- Anthropic's current best practice quantifies the ordering rule: **"Put longform data at the top:** Place your long documents and inputs near the top of your prompt, above your query, instructions, and examples… Queries at the end can improve response quality by up to 30 percent in tests, especially with complex, multidocument inputs." ([Prompting best practices — Long context prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices))
- Tam et al., **Let Me Speak Freely?** (arXiv 2408.02442): "a significant decline in LLMs' reasoning abilities under format restrictions… stricter format constraints generally lead to greater performance degradation in reasoning tasks." The implication for extraction: every additional output bucket and per-field micro-rule is a format constraint that taxes reasoning — the prompt's many exclusion clauses and ceiling rules have a measured cost class, not just a benefit. ([arXiv 2408.02442](https://arxiv.org/abs/2408.02442))
- OpenAI's model guidance adds the mid-tier qualifier: "Large models are more effective at understanding prompts and solving problems across domains, while small models are generally faster and cheaper" — and "GPT models… benefit from more explicit instructions." Read together: mid-tier models need explicitness *and* are the first to break under prompt bloat — so explicitness must come from exemplars and schema descriptions (high signal per token), not from more prose rules. ([Prompt engineering — Choosing a model](https://developers.openai.com/api/docs/guides/prompt-engineering))
- Google's checklist names the failure directly: **"Redundant instructions and examples:** …the exact same instruction or concept stated multiple times in slightly different ways without adding new information" and **"Irrelevant instructions and examples:** …can be removed without diminishing the model's ability to perform the core task." ([Overview of prompting strategies](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/prompt-design-strategies))

**Expected effect.** Across all four classes: every rule added to fix **P** (exclusions, ceilings, guard strips) risks class-**R** regressions by burying the capture rules mid-prompt — and vice versa. Practical consequences: (a) dedupe the current prompt's restated rules (the fulfilled-work rule appears in at least three wordings; the one-fact-once rule in two); (b) keep the high-signal-per-token forms (exemplars, schema descriptions, quote-checks) and cut advisory prose; (c) keep the answering instruction ("Reply via structured output…") and the self-check *last*, after the transcript — consistent with Anthropic's ordering result.

**Prompt phrasing example.** Not a wording change but a structural one — the message layout the evidence supports:

```text
System: identity + task + bucket definitions (short) + <examples> + exclusions (positive-framed, once each).
User: <trusted-context> (roster, identity state, Date reference line) then
<transcript> (the long data) then the answering instruction + self-check last.
```

The current builder (`buildDebriefMessages`) already places transcript in the user message with trusted context; the change implied here is moving the final self-check and the reply instruction to the *end of the user message* rather than leaving them system-side only, so the closest tokens to generation are the compliance rules (Anthropic's "instructions at the end" finding).

---

## 8. Ranked "apply next" list for our failure classes

Ordered by expected golden-score gain per prompt-editing effort, single-call only. Code-side enforcers (already researched in structured-extraction-determinism.md §§3.6–3.7) are noted where they compose; no multi-call pipeline is recommended — none of the reviewed evidence shows single-call techniques are insufficient for boundary-judgment failures like these.

| Rank | Change | Targets | Why first | Effort |
|------|--------|---------|-----------|--------|
| 1 | Add 3 tagged exemplars (§1): implicit-commitment capture, owner≠speaker, fulfilled-work `[]` | **R** ↑↑, **O** ↑, **P** ↑ | Best-evidenced single-call lever (Anthropic best practices + long-context study + Google); attacks the recall floor directly with the highest signal per token | S — one prompt edit |
| 2 | Move load-bearing rules into schema `description`s (§2): owner tie-break, dueDate copy-rule, evidence verbatim rule | **O** ↑, **D** ↑, shape errors → ~0 | OpenAI's "simpler prompting" benefit + description-evaluated-at-generation; complements prose without lengthening it much | S |
| 3 | Keep + sharpen the quote-grounded self-check (§3); make every check deletional and falsifiable | **P** ↑↑, **R** ↑ | CoVe/quote-scratchpad evidence; already half-built — this is editing, not inventing | S |
| 4 | Positive-framed owner selection order + beneficiary clause (§6) with one owner≠speaker exemplar | **O** ↑↑ | Converts the longest prose block in the prompt into an order + a check; removes prohibition-heavy wording most likely to echo | S |
| 5 | Freeze the date copy-rule (§5); add the weekday-in-quote check; change nothing else about dates | **D** ↑ | Date handling is already the prompt's strongest section per the literature (anchor + copy + null-on-vague); only the traceability check is missing | S |
| 6 | Single-call bucket ordering with later-buckets-defer-to-earlier dedup (§4) | **R** ↑, **P** ↑ (restatement class) | Cheapest available slice of the decomposition literature; no pipeline needed | S |
| 7 | Prompt diet + reorder (§7): dedupe restated rules, cut advisory prose, move reply instruction + self-check to end of user message | All classes (anti-regression) | Lost-in-the-Middle + Let-Me-Speak-Freely + Anthropic ordering; protects the gains from ranks 1–6 against bloat | M (requires re-eval per cut) |

Explicitly **not** recommended on current evidence: prohibition exemplars (rank-negative — §1 echo risk); multi-call per-bucket pipelines (§4 — unneeded complexity for boundary judgments); reasoning-before-JSON schema slots (see structured-extraction-determinism.md §3.5 — output-token cost against a Let-Me-Speak-Freely headwind; revisit only if long-transcript empties persist after ranks 1–3).

## 9. Sources — primary (every load-bearing claim)

1. https://developers.openai.com/api/docs/guides/structured-outputs — shape guarantee ("adhere to your supplied JSON Schema… omitting a required key… invalid enum value"), "Simpler prompting" benefit, extraction recipe (short instruction + schema) (§2)
2. https://developers.openai.com/api/docs/guides/prompt-engineering — model-size/explicitness trade-off ("Large models are more effective… small models…"), message roles, version-prompts-in-code (§7)
3. https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices — 3–5 relevant/diverse/tagged `<example>`s; "Tell Claude what to do instead of what not to do"; long-data-at-top + "Queries at the end can improve response quality by up to 30 percent"; quote-grounding rule (§§1, 3, 7)
4. https://platform.claude.com/docs/en/build-with-claude/structured-outputs — constrained-decoding guarantee ("Always valid… Type safe… Reliable: No retries needed for schema violations") as shape-only (§2)
5. https://www.anthropic.com/news/prompting-long-context — quote scratchpad "helpful in all head-to-head comparisons"; contextual examples help / generic do not / more is better; instructions-at-end ordering (§§1, 3, 7)
6. https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/few-shot-examples — exemplars regulate "formatting, phrasing, scoping"; unintended-pattern warning; overfitting bound (§§1, 6)
7. https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/prompt-design-strategies — prompt components (Context, Recap); health checklist (Too many tasks, CoT order, redundant/irrelevant instructions, missing format spec) (§§2, 4, 5, 7)
8. https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/break-down-prompts — chained vs aggregate (parallel-per-bucket) decomposition shapes (§4)
9. https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/explain-reasoning — reasoning-steps improve accuracy/nuance "especially for challenging queries"; think-step-by-step in `think`/`answer` JSON fields (§§3–4)
10. https://arxiv.org/abs/2309.11495 — Dhuliawala et al., CoVe: draft → independent verification questions → verified response; hallucination decreases across list/QA/longform tasks (§3)
11. https://arxiv.org/abs/2303.17651 — Madaan et al., Self-Refine: single-LLM generator/feedback/refiner, ~20% absolute mean gain multi-iteration (§3)
12. https://arxiv.org/abs/2307.03172 — Liu et al., Lost in the Middle: U-shaped positional recall, mid-context degradation even for long-context models (§7)
13. https://arxiv.org/abs/2408.02442 — Tam et al., Let Me Speak Freely?: format restrictions significantly degrade reasoning; stricter → worse (§7)
14. https://arxiv.org/abs/2210.02406 — Khot et al., Decomposed Prompting: modular sub-task delegation beats few-shot prompting, multi-call (§4)
15. https://arxiv.org/abs/2205.10625 — Zhou et al., Least-to-Most: sequential subproblems conditioning on prior answers; 99% vs 16% on SCAN length-split (§4)
16. https://arxiv.org/abs/2404.07775 — Gautam et al.: LLM temporal-expression normalization via in-context learning with task+document+examples; document date in prompt; dynamic relevant examples (§5)
17. https://stanfordnlp.github.io/CoreNLP/sutime.html — SUTime: temporal expressions "resolved relative to the document date" (§5)

## 10. Sources — repo (grounding, not claims)

- `apps/server/src/modules/meeting-debrief/extraction.ts` — `DEBRIEF_SYSTEM_PROMPT` (`:18-190`), owner block (`:82-100`), dueDate block (`:107-128`), openQuestions (`:129-145`), self-check (`:181-188`), `dateReferenceLine` (`:319-329`), `resolveActionItemOwners` (`:452-478`)
- `docs/research/structured-extraction-determinism.md` — repair-loop (§3.6) and code-normalizer (§3.7) companions to §§3/5/6 above; reasoning-before-JSON cost discussion (§3.5)
