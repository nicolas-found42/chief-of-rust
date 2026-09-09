# Person extraction boundary diagnosis, 2026-09-06

Bounded follow-up for issue #228. Model remained the configured
`openrouter / z-ai/glm-5.3-flash`, resolved through `ConfigStore.getForPurpose`.
No response content, reasoning text, or credentials were written to this note.
No reference corpus changed.

## Concrete findings

The production extraction prompt prohibited calling tools while its new binding
preference explicitly requested the `save_extraction` tool. The instruction now
prohibits following commands in the document or identifiers, preserving the
prompt-injection rule without contradicting the required output mechanism.
The benchmark prompt version is `2026-09-06.4`. This is a correctness repair;
the live checks below do **not** establish that it resolves the extraction
failure.

The streaming boundary also concatenated arguments from every tool-call index
into one JSON string. The nonstream reader selects the first tool call instead.
A deterministic, entirely synthetic reproduction using the real
`makeCompleteJson` boundary returned a schema-valid dossier for one tool call,
and `answer_not_json` for two individually valid calls with indices 0 and 1.
This proves a protocol reconstruction defect, independently of whether the live
model failure has that cause. The corresponding production repair was handed
to the separate provider-boundary reviewer; this note's author did not edit
the parser.

## Observed runs

1. `/private/tmp/issue-228-tool-prompt-conflict.mts` performed one actual model
   call through `PersonResearch` and the configured provider, replacing only the
   conflicting system sentence in that harness. It finished after 57,834 ms
   with `answer_not_json`, HTTP 200, binding `forced_tool_call`, and
   `finishReason: tool_calls`; reconstructed diagnostic body length was 3,487
   bytes. No claims were published. This is **not a controlled comparison with
   the prior CLI runs**: its reader marked completeness full, used the
   publisher as author, and its created profile omitted the employer hint.
   Actual fixed-document CLI ports use partial completeness and null author.
2. The exact existing temporary corpus then ran with the corrected production
   prompt, no fetch overrides, and the configured default judge:

   ```sh
   pnpm exec tsx scripts/person-research-benchmark.mts \
     --mode fixed-documents --pipeline expanded \
     --corpus /private/tmp/issue-228-small-fixed-corpus \
     --out /private/tmp/issue-228-small-fixed-scoped-prompt
   ```

   Run `63f940653c1867a4`, corpus `ead8f30f1cf6c27c`, prompt
   `2026-09-06.4`: **failed**, 0 claims, 0/1 facts recovered, judge completed.
   Extraction ran from `09:37:09.280Z` to `09:37:39.535Z` and hit the
   **30-second idle ceiling**, with HTTP 200 and 1,775 observed wire bytes.
   This differs from earlier 120-second absolute-ceiling failures. The
   diagnostic does not identify whether these bytes were comments, reasoning,
   answer tokens, or other events. The sentence change is insufficient proof
   of recovery.
3. `/private/tmp/issue-228-tool-index-repro.mts` performs no real network or
   model calls. It uses synthetic SSE with one versus two tool-call indices,
   each containing an independently valid full dossier object. One succeeds;
   two produce `answer_not_json`. This is a fast red-capable protocol test,
   not acceptance evidence for the actual model.

Logs and reports remain in `/private/tmp/issue-228-tool-prompt-conflict.log`,
`/private/tmp/issue-228-small-fixed-scoped-prompt.log`, and the matching
scoped-prompt output directory, including its per-person operation JSON.
The observations above are retained here because temporary files can expire.

## Ranked hypotheses and falsifiable next observations

1. **Multiple tool calls become invalid concatenated JSON.** Proven as a local
   protocol defect; live relevance unproven. On the next needed production run,
   count distinct tool-call indices and record per-index JSON validity versus
   concatenated validity. If one index alone is invalid, this defect does not
   explain that call. Never persist argument text.
2. **The upstream produces a long reasoning phase or pauses before answer
   generation.** Full-schema failures and the successful simple-schema call
   make request complexity relevant, but wire bytes alone cannot distinguish
   reasoning from content. Record counts/byte lengths per delta surface and
   first/last activity times. Reasoning contents must be discarded. Repeated
   comments without accepted token surfaces explain the 30-second idle event;
   sustained reasoning explains a different 120-second absolute event.
3. **The tool prohibition conflicts with forced tool choice.** The literal
   conflict existed and is corrected. Its causal contribution remains
   unproven: the exact corrected-prompt CLI still failed. Do not describe it
   as the root cause based on the non-equivalent harness changing symptoms.
4. **Full-schema constrained decoding has a provider-specific failure.** The
   full schema includes nested objects, large allowed arrays, regexes, nullable
   values, and optional properties. `wireJsonSchema` expands references; the
   schema is not recursive. A one-field success does not establish which
   feature matters. Once protocol reconstruction is correct, inspect schema
   validation facts and controlled simplifications for diagnosis only; continue
   validating the final response against the original full contract. Do not
   substitute a weakened extraction contract for acceptance.
5. **Stream completion handling loses a valid terminal response.** The reader
   observes `finish_reason` but completes on `[DONE]` or EOF. Record whether
   terminal reasons occur before a timeout and whether either terminator is
   seen. A timeout with neither answer nor terminal signal weighs against this
   explanation. No change to timeout policy is justified by present evidence.

The next accepted experiment is the same small production CLI after the
per-index reconstruction repair, with observation-only counters. It should
measure the actual changed production path, keep the corpus and judge fixed,
and preserve failures. No additional live variants were launched by this
diagnostic subtask after the scoped-prompt result.

Focused verification after the prompt correction: 68 tests passed across
`person-research.test.ts`, `person-research-model-diagnostics.test.ts`, and
`providers.test.ts`; changed-file Prettier and `git diff --check` passed.

## Observation-only production check after parser and activity repairs

The exact small fixed-document CLI ran again through an observation-only fetch
wrapper after the per-index parser and typed reasoning-activity repairs. The
wrapper passed the original request object and exact response bytes unchanged.
A synthetic check verified per-index versus concatenated JSON validity and
confirmed no request text, answer text, or reasoning text appeared in its log.
Only lengths, bounded field/type counts, schema root keys, status and timings
were retained. Answer fragments existed transiently to check JSON validity;
reasoning text was never accumulated. The wrapper's `abort` event also occurs
when the production reader cleans up after `[DONE]`, so it is not independently
a failure classification.

Run `dc284374d4964886`, from `2026-09-06T09:43:15.108Z` to
`09:44:43.192Z`, used the same corpus `ead8f30f1cf6c27c`, prompt `.4`, configured
model, default judge, and no request-parameter overrides. It failed with zero
claims, zero of one facts recovered, one ambiguous fact, interrupted research
and failed judge assessment. Temporary log:
`/private/tmp/issue-228-small-fixed-index-observed.log`; report directory:
`/private/tmp/issue-228-small-fixed-index-observed`.

| Request | Binding / schema bytes | Observed surfaces | Completion evidence |
| --- | --- | --- | --- |
| Extraction | forced tool call / 7,870 | HTTP 200; 3,646 wire bytes; 103 comments; three content/role/tool-call deltas; zero reasoning text or details; one tool index (0), 11 argument characters, invalid JSON | First delta 13,789 ms; last 13,849 ms; abort 43,851 ms; no finish reason or DONE |
| Fact judge | response format / 598 | HTTP 200; 44,117 wire bytes; 136 data events; 258 reasoning characters, 57 reasoning.text detail events; 329 content characters, valid JSON | First delta 1,343 ms; last 2,502 ms; cleanup abort 2,505 ms; stop and DONE observed |
| Usefulness judge | response format / 1,052 | HTTP 200; 67,177 wire bytes; 85 comments; 229 data events; 108 reasoning characters, 22 reasoning.text detail events; 973 content characters, invalid JSON | First delta 795 ms; last 11,551 ms; abort 41,553 ms; no finish reason or DONE |

For this run, mixed tool indices and unrecognized reasoning heartbeats are
falsified as the extraction failure's explanation. It emitted one incomplete
tool call, followed by a genuine 30-second gap in token activity. A separate,
substantially smaller usefulness schema also stalled after partial content.
Schema complexity alone therefore does not explain all observed failures.
Neither failed call had a terminal signal or valid completed answer to recover.
The protocol and prompt repairs remain valid correctness fixes, without being
claimed as the cause of these particular upstream stalls.

A possible next implementation is one same-binding retry for a classified
retryable idle stall, sharing the original 120-second absolute deadline and
preserving both attempt diagnostics. This is a hypothesis for resilience, not
an established recovery result. It must not retry refusals, weaken the result
shape, switch model, or extend the deadline. No such retry was implemented by
this diagnostic subtask and no additional live variant was launched here.

## Production check with bounded same-binding retry enabled

After the separately implemented bounded retry and durable attempt observation
changes, shared built successfully and the exact small CLI ran once through the
same safe observer. There were no model-setting overrides. Run
`66ed88fb3d6a061d`, `2026-09-06T09:54:27.435Z`–`09:57:17.071Z`, used the same
corpus and prompt, with judge version `2026-09-06.3`. It made **three wire calls
and zero retries**:

- Extraction succeeded on its first forced-tool attempt after 43,193 ms. One
  tool index carried 5,257 characters of valid JSON; tool_calls and DONE were
  present. The full production validation/publication path yielded three
  claims, one work, one expertise item and two grounded section summaries.
- The fact judge succeeded on its first response-format attempt after 6,132 ms,
  with 407 characters of valid JSON and stop/DONE.
- The usefulness judge exhausted the original 120-second absolute deadline on
  its first response-format attempt. It produced 1,819,562 wire bytes, 4,793
  data events, 20,742 reasoning characters and 4,677 reasoning.text detail
  events. Its 442 content characters were incomplete JSON. Activity continued
  through 120,000 ms; no finish reason or DONE was observed. There was no
  remaining deadline for a retry, and none occurred.

The overall run remains **failed** with one ambiguous reference fact. The
current evaluator replaces fact verdicts with an ambiguous assessment when the
later usefulness judge fails; the full dossier extraction succeeded, but this
run does not establish assessed recovery. Durable judge `modelAttempts` records
first-call success and second-call failure with `request_timeout`,
`timeoutMs: 120000`, and the original-deadline-expired stopped reason. This
observed run therefore verifies terminal attempt accounting and successful full
production extraction, **not retry recovery**.

The remaining failure is now a long active reasoning phase in the usefulness
judge, unlike the previous idle stalls. Hidden reasoning contents were never
logged or retained by the observer. No further model variant was launched.
Temporary evidence is in `/private/tmp/issue-228-small-fixed-bounded-retry.log`
and `/private/tmp/issue-228-small-fixed-bounded-retry`.

## Completed end-to-end smoke with declared tool preference for judges

The successful extraction dossier from the preceding run could not support an
exact-input judge comparison: the CLI deletes its temporary workspace, and its
reports retain metrics and observations rather than the entire dossier and
sources. The observer deliberately did not persist model answer or request
contents. The next authorized test therefore regenerated extraction and tested
end-to-end candidate behavior, **not one isolated binding variable against an
identical judge payload**.

After the production judge calls gained the existing model-declared
`forced_tool_call` preference, shared built successfully and the exact tiny
corpus CLI completed. Run `39e8f583d614ad67`,
`2026-09-06T10:00:35.211Z`–`10:01:32.277Z`, used unchanged corpus
`ead8f30f1cf6c27c`, prompt `.4`, and judge version `2026-09-06.4`. Model,
configuration and deadlines were unchanged. All three wire calls used forced
tool choice, succeeded on their first attempt, and ended with tool_calls/DONE:

| Call | Elapsed | Tool argument characters | JSON valid | Reasoning characters |
| --- | --- | --- | --- | --- |
| Full extraction | 24,891 ms | 3,905 | yes | 27 |
| Fact judge | 12,200 ms | 473 | yes | 10 |
| Usefulness judge | 19,758 ms | 1,565 | yes | 842 |

The run exited zero with completed research, integrity and judge assessment.
One published claim recovered the one reference fact; two of two citations
verified, with zero critical findings. Two minor partial-source findings remain,
as does one uncertain overclaim judgment requiring review. Usefulness scores
were understanding 1/3, remaining questions 1/3 and conversation readiness 0/3,
which accurately leaves this tiny dossier below full meeting preparation.
There were no retries, so retry recovery remains untested by live success.

This establishes a complete successful small production path. It does not
establish broad-corpus reliability, a controlled causal attribution to binding,
or completeness of the overall issue. The uncertain judgment and low
usefulness scores are preserved rather than relabeled as a clean content pass.
No additional model variant was launched by this subtask.

Evidence: `/private/tmp/issue-228-small-fixed-tool-judge.log` and
`/private/tmp/issue-228-small-fixed-tool-judge/fixed-documents-expanded-39e8f583d614ad67.json`.

## Full Achim Steiner sampling diagnostics

Two explicitly diagnostic harness runs used `evaluatePerson`, canonical corpus
`3dedb8c8e53a4f4c`, Achim's two actual retained documents, expanded settings
(60 profile calls, 900,000 ms, read concurrency 4), configured purpose-specific
models, and isolated temporary workspaces. These are candidate sampling probes,
not accepted benchmark comparisons. No production source or model configuration
changed in these harnesses. Each extraction retained the full 7,870-byte schema
and declared forced-tool preference.

1. Extraction temperature 1 with default reasoning exhausted the original
   absolute deadline (119,735 ms observed within fetch). It received HTTP 200,
   311,198 wire bytes, 806 reasoning/detail events and 3,534 reasoning
   characters, with zero content or tool arguments and no terminal marker.
   Both judges completed; research remained interrupted, with zero claims and
   zero of four facts recovered.
2. Extraction temperature 1 plus supported reasoning effort low also exhausted
   the original deadline (119,918 ms observed). It received HTTP 200, 1,136,209
   wire bytes, 2,985 reasoning/detail events and 12,916 reasoning characters,
   with zero content or tool arguments and no terminal marker. The low-effort
   fetch transform was explicitly restricted to the extraction schema; judges
   were untouched. Research again remained interrupted, with zero claims and
   zero of four facts recovered. The usefulness judge recovered through the
   existing repetition-loop forced-tool-to-prompt-only path, recorded as two
   durable wire attempts. This was not same-binding retry recovery.

Neither candidate was adopted. They show that temperature 1, including its
combination with low reasoning and forced tool choice, does not suffice to
recover this full-person extraction. They do not justify extending deadlines
or weakening the accepted contract. The usefulness inputs differed during
concurrent production judge changes, so these runs do not establish a
controlled judge comparison; the extraction requests matched except for the
explicit reasoning parameter (17,307 versus 17,336 request bytes).

Temporary sanitized reports and operation records are at
`/private/tmp/issue-228-achim-temperature-one.{report,operation}.json` and
`/private/tmp/issue-228-achim-temperature-one-low.{report,operation}.json`, with
matching `.log` files. An initial harness startup used the wrong corpus parent
directory, failed validation before any model call, and was corrected to
`benchmark/person-research/people` before both observations above.

## Reduced-shape diagnostic: core claims also stall

One final authorized structural diagnostic used the same full Achim corpus and
production evaluator with temperature 0, default reasoning and forced-tool
preference. Only the temporary harness omitted `sourceIds`, `works`,
`expertise`, `connections` and `sections` from the requested result shape,
retaining the full claims and metadata contract. Its intended return adapter
would restore omitted arrays empty, but no extraction response completed, so
that adapter never ran. This deliberately reduced shape is **not acceptance
or a proposed production contract**.

The schema shrank from 7,870 to 2,217 bytes and the request to 11,654 bytes.
Both extraction attempts failed:

- First wire attempt: HTTP 200, 6,016 bytes, 75 comments, 51 reasoning
  characters; one tool index with 11 invalid-JSON argument characters. Last
  delta 2,402 ms, idle abort 32,404 ms; no terminal marker.
- Same-binding retry: HTTP 200, 3,989 bytes, 71 comments, 15 reasoning
  characters; one tool index with 11 invalid-JSON argument characters. Last
  delta 480 ms, idle abort 30,481 ms; no terminal marker.

The bounded same-binding retry was exercised and did not recover. Both judges
subsequently completed; the result remained interrupted research, zero claims,
and zero of four facts recovered. This does not support adopting a staged
extraction design on the assumption that core claims alone will avoid the
stall. All further probes in this diagnostic subtask stopped as directed.

Evidence: `/private/tmp/issue-228-achim-reduced-shape.log`,
`/private/tmp/issue-228-achim-reduced-shape.report.json` and
`/private/tmp/issue-228-achim-reduced-shape.operation.json`.

## Full-contract prompt-only protocol diagnostic

A final separately authorized protocol probe used an isolated synthetic endpoint
metadata response declaring only `supported_parameters: ["temperature"]`.
This is explicitly **not an actual capability claim**. It made the existing
production provider select prompt-only for both request construction and
response parsing; no mismatched wire-only binding mutation occurred. The full
original extraction schema remained in the production prompt and normal
runtime validation. Canonical full Achim inputs, temperature 0, default
reasoning, configured model and deadlines were unchanged. Judges were
intentionally excluded from this extraction-only diagnostic.

The single extraction wire call failed at the original 120,000 ms deadline:
HTTP 200, 4,000,343 wire bytes, 10,548 reasoning/detail events and 44,944
reasoning characters, with zero answer content and no finish marker. Last
activity occurred at 119,511 ms. The request was 30,550 bytes; the observer's
schemaBytes value is zero because it measures structured wire schema fields,
whereas prompt-only carries the complete schema inside the prompt. No answer
reached full-schema validation; zero claims were published. There was no
remaining deadline for a retry.

This distinct protocol test also failed to recover full-person extraction and
was not adopted. It remains diagnostic, not benchmark acceptance or evidence
that the model actually lacks structured-output capabilities. No additional
probe was launched by this subtask.

Evidence: `/private/tmp/issue-228-achim-prompt-only.log`,
`/private/tmp/issue-228-achim-prompt-only.report.json`, and
`/private/tmp/issue-228-achim-prompt-only.operation.json`.


## Read-only upstream route inventory

The [official OpenRouter endpoint metadata](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints) returned anonymous HTTP 200 at `2026-09-06T10:24:00.254040+00:00`. It lists 23 distinct upstream routes for the same `z-ai/glm-5.3-flash` model. No completion request or configuration change was made. Status codes below are preserved as raw metadata, without inferring their undocumented meaning. Every latency and throughput field in this snapshot is null, so this evidence does not support a speed ranking.

| Provider | Endpoint tag | Raw status | Tools / tool choice / response format |
| --- | --- | --- | --- |
| GMICloud | `gmicloud/fp8` | 0 | yes / yes / yes |
| Novita | `novita/fp8` | 0 | yes / yes / yes |
| DeepInfra | `deepinfra/fp4` | 0 | yes / yes / yes |
| Z.AI | `z-ai/fp8` | 0 | yes / yes / yes |
| Wafer | `wafer` | 0 | yes / yes / yes |
| Makora | `makora` | 0 | yes / yes / yes |
| Modal | `modal/fp8` | 0 | yes / no / yes |
| CoreWeave | `coreweave/fp8` | 0 | yes / yes / yes |
| Sail Research | `sail-research/fp8` | 0 | yes / yes / yes |
| StreamLake | `streamlake` | 0 | yes / yes / yes |
| NextBit | `nextbit/fp8` | 0 | yes / yes / yes |
| Fireworks | `fireworks` | 0 | yes / yes / yes |
| Friendli | `friendli` | 0 | yes / yes / yes |
| SiliconFlow | `siliconflow/fp8` | 0 | yes / yes / no |
| DigitalOcean | `digitalocean` | 0 | yes / yes / yes |
| Together | `together` | 0 | yes / yes / yes |
| Reka | `reka/fp8` | 0 | yes / yes / yes |
| Parasail | `parasail/fp8` | -2 | yes / yes / yes |
| BaseTen | `baseten/fp8` | 0 | yes / yes / yes |
| Venice | `venice` | 0 | yes / yes / yes |
| Io Net | `io-net/fp8` | 0 | yes / yes / no |
| Cloudflare | `cloudflare` | 0 | yes / yes / yes |
| Morph | `morph/fp8` | 0 | yes / yes / yes |

The official [provider routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection) describes selecting upstreams within a model using provider preferences, including `only`, `order`, and `allow_fallbacks`. Thus same-model routing is an available external variable, but the routes serving the previous failed calls were not measured by the observer and cannot be inferred from this inventory. The production metadata union also does not prove that every individual route supports every declared parameter.

The allowlisted raw snapshot, including complete supported-parameter lists and available uptime fields, is `/private/tmp/issue-228-glm-endpoint-metadata.json`. No secrets or model contents were collected.

## Pinned same-model upstream diagnostic

Official endpoint metadata identified routing tags `fireworks` and `together`,
both declaring temperature, tools, tool_choice and reasoning support. Following
the official provider-routing API, a temporary extraction-only fetch transform
set `provider.order` to one tag, `allow_fallbacks: false`, and
`require_parameters: true`. Full Achim inputs, full schema, temperature 0,
default reasoning, configured model, production parser and deadlines remained
unchanged. No configuration or production source changed.

- Fireworks returned HTTP 429 after 344 ms, with 645 bytes and no model output.
  The structured boundary identified `upstreamServer: Fireworks` and
  `upstreamCode: 429`.
- The explicitly authorized sequential fallback, Together, returned HTTP 429
  after 147 ms, with 598 bytes and no model output. The structured boundary
  identified `upstreamServer: Together` and `upstreamCode: 429`.

Each diagnostic made one extraction request. Judges were skipped because
extraction failed. Neither result can establish how that upstream would perform
on the extraction task; both were unavailable for these requests. No further
route was tried. Evidence is in the matching `.log`, `.report.json`, and
`.operation.json` files under `/private/tmp/issue-228-achim-fireworks` and
`/private/tmp/issue-228-achim-together`.

Separately, read-only [official model metadata](https://openrouter.ai/api/v1/models)
at `2026-09-06T10:26:00.659655Z` reported mandatory reasoning, enabled by default,
with efforts max/high/low and default max. `reasoning.supports_max_tokens` was
absent. `default_parameters` contained temperature 1 and top_p 0.95;
`default_parameters.max_tokens` was absent. Generic max_tokens parameter support
does not establish support for an explicit reasoning-token budget, and endpoint
max_completion_tokens values are caps rather than defaults. The allowlisted
snapshot is `/private/tmp/issue-228-glm-model-metadata.json`.

## Explicit total-output allowance with low reasoning

A separately authorized diagnostic set extraction `max_tokens: 8192` and
`reasoning.effort: low`, retaining full Achim inputs, the full schema,
temperature 0, forced tool choice, default routing and the original deadline.
This used the declared generic total-output parameter, **not** unsupported or
unverified `reasoning.max_tokens`, and did not infer any default allowance from
endpoint caps. The temporary transform did not affect judges or configuration.

Both extraction wire attempts failed through actual 30-second idle gaps:

| Attempt | Safe observed upstream | Elapsed | Last delta | Wire bytes | Reasoning characters |
| --- | --- | --- | --- | --- | --- |
| First | NextBit | 49,536 ms | 19,533 ms | 6,746 | 58 |
| Same-binding retry | NextBit | 35,655 ms | 5,651 ms | 7,439 | 71 |

Both returned HTTP 200 with no answer content, tool arguments, finish reason or
DONE. The safe observer retained the allowlisted top-level provider name,
providing direct upstream attribution for these two stalls. Zero claims were
published; judges were skipped after failure. The total-output allowance plus
low reasoning did not recover extraction and was not adopted. The bounded
retry remained inside the original request deadline. Evidence is in
`/private/tmp/issue-228-achim-total-cap.{log,report.json,operation.json}`.

## Different available upstream: DeepInfra also stalls

The separately authorized route-only control pinned the official metadata's
exact `deepinfra/fp4` endpoint tag with fallbacks disabled and required parameter
support. Unlike Fireworks and Together, this upstream accepted both requests:
HTTP 200 and safe top-level provider attribution `DeepInfra` were observed.
Full original Achim inputs, full schema, temperature 0, default reasoning, no
explicit output cap, configured model and deadlines remained unchanged.

The first extraction attempt stalled at 35,618 ms after its last delta at
5,616 ms (4,441 wire bytes, 58 reasoning characters). Its same-binding retry
stalled at 41,127 ms after its last delta at 11,125 ms (4,391 wire bytes,
58 reasoning characters). Neither produced content, tool arguments, finish
reason or DONE. Zero claims were published; judges were skipped. The bounded
retry did not recover, and no further route was tried.

This distinguishes a working route from the earlier 429 responses and shows
that the observed stalled extraction behavior is not unique to NextBit. It
does not identify a more specific model/request/upstream cause. No routing
change was adopted. Evidence: `/private/tmp/issue-228-achim-deepinfra.log` and
the matching `.report.json` and `.operation.json` files.

## First-1,000-character input-window diagnostic

One authorized input-window diagnostic kept the full retained 6,000-character
Achim source unchanged while the temporary completion wrapper sent only its
first 1,000 characters and marked model document completeness partial. Selection
was a plain character prefix, never reference-fact-based. Full schema,
temperature 0, default reasoning/routing, forced tool choice, runtime validation
and the original deadline remained unchanged. This was not acceptance or full
source coverage.

The first attempt, safely attributed to Wafer, stalled at 31,003 ms after its
last delta at 1,000 ms: 65 reasoning characters and one tool index with 11
invalid-JSON argument characters. Its same-binding retry routed to Io Net and
spent the remaining 88,341 ms of the original deadline in active reasoning
(6,842 characters), with no answer content or tool arguments. Neither had a
finish marker. Zero claims were published, and judges were skipped.

This input-window control did not recover extraction. It therefore does not
support implementing chunked extraction on the assumption that this prefix
size resolves the failure; no chunking change was implemented or adopted.
Evidence: `/private/tmp/issue-228-achim-input-window.log` and its matching
`.report.json` and `.operation.json` files.

## Focused primary-source serving investigation

Read-only research on September 6 found a specific server-side incompatibility
with symptoms relevant to this investigation, but **no verified client request
fix or attribution to the upstreams observed here**.

- [SGLang issue #36879](https://github.com/sgl-project/sglang/issues/36879),
  opened August 28, documents two GLM-5.3-Flash MHC communicator reduction
  omissions. Under DP attention, no MoE all-to-all backend, and equal TP/EP/DP
  sizes greater than one, it reports repetitive reasoning, empty content and
  tool-schema failures. A partially repaired build could pass simple smoke
  tests while failing more involved tool calls. This is a specific serving
  configuration defect, not evidence that every GLM deployment is broken.
- [Fix #36884](https://github.com/sgl-project/sglang/pull/36884) merged on
  `2026-08-28T20:34:17Z`, commit
  `6611363be5111b1a4bd48aa806d4c98490dca950`, correcting both omissions.
  [Flash integration #36507](https://github.com/sgl-project/sglang/pull/36507)
  merged on `2026-09-06T09:28:00Z`. GitHub's primary API verified the merge
  timestamps. The actionable serving check is to verify the actual upstream
  engine/build, inclusion of both fixes and the TP/EP/DP configuration. None of
  those facts is present in our OpenRouter endpoint metadata or safe stream
  observations, so this remains a candidate external cause, not a diagnosis.
- The [official vLLM Flash recipe](https://recipes.vllm.ai/zai-org/GLM-5.3-Flash),
  updated September 5, specifies the `glm47` tool parser, `glm45` reasoning
  parser and automatic tool-choice support for serving. It explains that
  reasoning is always enabled and low/high must be explicitly mapped into the
  template; other effort values select max. These are concrete upstream
  configuration checks, not additional unverified parameters to send through
  OpenRouter.
- The [Z.ai model card](https://huggingface.co/zai-org/GLM-5.3-Flash/raw/main/README.md)
  recommends `clear_thinking=true` for chat. Inspection of the
  [actual template](https://huggingface.co/zai-org/GLM-5.3-Flash/raw/main/chat_template.jinja)
  shows that this controls retention of prior assistant reasoning. Our
  extraction request contains no prior assistant turns; changing it would not
  address that mechanism. Tool-result reordering likewise concerns histories
  containing tool results, absent from this extraction request.
- [Z.ai's direct tool-streaming documentation](https://docs.z.ai/guides/capabilities/stream-tool)
  and [chat API reference](https://docs.z.ai/api-reference/llm/chat-completion)
  document `tool_stream=true` alongside `stream=true` for incremental tool
  argument delivery. This documentation targets Z.ai's direct API. No primary
  OpenRouter source found here establishes passthrough or required use for its
  third-party GLM endpoints, so adding it to our OpenRouter requests is not a
  supported fix on present evidence.

No model calls, routing probes, configuration changes or production code edits
were made during this research. The strongest new action is an upstream
serving-version/configuration investigation tied to the specific SGLang fix,
not another sampling or timeout change. No message was sent to a provider.

## Official Z.AI route control unavailable

A fresh anonymous endpoint read at `2026-09-06T10:58:33.831160Z` confirmed
`provider_name: Z.AI`, exact tag `z-ai/fp8`, raw status 0 and declared tools,
tool_choice and temperature support. The authorized original full-Achim
route-only control pinned that tag, disabled fallbacks and required parameter
support, keeping full schema, temperature 0, default reasoning, configured
model, runtime boundary and deadline unchanged.

The single request returned HTTP 404 after 36 ms (312 bytes). The sanitized
boundary had no upstream server attribution and upstream code 404; there was
no model output. Judges were skipped after extraction failed, and no other
route was tried. The listed route was not exercised successfully for this
request, so the test cannot distinguish maker-hosted behavior from third-party
serving compatibility. A route name alone would not establish a serving build
version even if it had succeeded.

Evidence: `/private/tmp/issue-228-zai-route-metadata.json`,
`/private/tmp/issue-228-achim-zai.log`, and matching `.report.json` and
`.operation.json` files. No configuration or production source changed.

## Z.AI automatic-tool controls

A later read of the [public endpoint metadata](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints)
exposed a detail omitted from the earlier route summary: Z.AI declares
`supports_tool_choice.auto: true`, but `function: false` and `required: false`.
Thus the earlier forced-function request was incompatible with that endpoint's
specific declaration despite the broad `tools`/`tool_choice` parameter names.
This is newly inspected metadata detail, not evidence that the upstream changed.

A diagnostic changed the pinned extraction request to automatic tool selection,
preserving the complete 7,870-byte schema, temperature 0, default reasoning,
configured GLM model and 120-second total deadline. It reached HTTP 200 with
explicit Z.AI attribution. Over 119,899 ms it received 2,122,930 wire bytes,
5,588 data events and 24,018 reasoning characters, but zero answer characters,
zero tool arguments and no finish reason. The observer retained counts only,
not reasoning content. The original deadline interrupted the call; zero claims
were published. Automatic tool selection therefore resolved the route refusal
but did not establish a usable extraction setting.

A follow-up kept that control and requested low reasoning effort. Both bounded
attempts ended at 30,002 ms with HTTP 200, 1,775 bytes and 71 heartbeat comments,
but zero data events or answer/tool content. Neither attempt produced upstream
attribution. Judges were skipped after extraction failed. No diagnostic binding,
reasoning or routing override was adopted in production.

Sanitized operation, result and activity-count files are preserved under
`artifacts/person-benchmark/diagnostics-2026-09-06/issue-228-achim-zai-auto*`.
The current endpoint metadata is retained alongside them. Logical provider
diagnostics still name the adapter's original binding; these explicitly labeled
wire-override controls and their observer records identify automatic selection.
They are diagnostics, not acceptance runs.

## Named cause, 2026-09-06 (issue #232)

**The configured model stops a few tokens into the tool call's argument JSON whenever the
extraction has substantive content to produce, and then holds the stream open with keepalive
comments until the client's 30-second idle ceiling fires.**

Nothing about this is a client defect: there is no completed answer being discarded, no route
that would have answered, and no reasoning phase in progress. The model emits `role`, a few dozen
reasoning characters and exactly **11 characters of tool-argument JSON** inside the first two
seconds, and then produces no further token for thirty seconds while the upstream sends SSE
comments.

The only production change this diagnosis made is an observation: the streaming boundary now
records the serving upstream on a stalled call, which a refusal body already carried and a
timeout did not. No request parameter, model, provider or deadline was changed, and no override
was left in place.

### Observations

All counts are shape-only. No request text, answer text or reasoning text was written anywhere.

Twelve consecutive production extraction attempts for `achim-steiner` stalled across six CLI runs;
eight of eight harness attempts with the same reference document stalled. Every one: HTTP 200, the
30,000 ms idle ceiling, no `finish_reason`, no `[DONE]`.

| Attempt | Route | Data events | Comments | content chars | reasoning chars | tool-argument chars | Last counted activity | Longest silence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Wafer | 10 | 73 | 0 | 36 | 11 | 1,891 ms | 29,796 ms |
| 2 | Wafer | 14 | 72 | 0 | 56 | 11 | 1,520 ms | 29,908 ms |
| 3 | Wafer | 17 | 74 | 0 | 71 | 11 | 2,054 ms | 29,900 ms |

The eleven characters are the same eleven the first diagnostic session recorded. They are the
opening of the argument object and never grow.

### What this falsifies

- **The serving upstream.** OpenRouter routes this model id across 23 upstreams and the boundary
  now names the one that served each call. The stall reproduces on `Wafer` and on `NextBit`, and
  both of those answer the same request shape when the answer is an empty result set. A route is
  not the variable.
- **Request size.** Requests padded to 16,000, 32,000 and 60,000 characters answered ten times out
  of ten. The unpadded 6,373-character request carrying the real reference document failed eight
  times out of eight. Larger requests succeed; this smaller one does not.
- **The system prompt.** The production extraction prompt and a one-sentence replacement both
  answer on filler and both stall on the real document. The prompt is not the variable.
- **A long reasoning phase.** These calls carry 36–71 reasoning characters in total, all of them
  inside the first two seconds. The separately recorded usefulness-judge failure with 44,944
  reasoning characters is a genuinely different failure and stays recorded as its own thing.
- **Terminal-signal loss in stream completion.** There is no valid completed response to lose:
  zero content characters, eleven tool-argument characters, and no terminator of any kind. No
  change to timeout policy is justified by this evidence either.

The one variable that separates a stalling request from an answering one is whether the extraction
has substantive content to produce. Filler yields an empty result set and completes; the real
biography does not.

### Same-request model comparison

Diagnostic only. Nothing here was adopted, and no configuration changed. Identical document,
schema, binding, temperature and system prompt; two attempts each.

| Model | Outcome | Elapsed | Evidence |
| --- | --- | --- | --- |
| `z-ai/glm-5.3-flash` (configured) | idle-ceiling stall | 32 s | 11 tool-argument characters, 0 content, no terminator |
| `upstage/solar-pro4` | absolute-deadline stall | 120 s | 15,340–22,129 tool-argument characters, still generating at the ceiling |
| `openai/gpt-oss-20b` | `unusable_shape` | 8–14 s | 6,529–11,705 content characters, `finish:stop` and `[DONE]`; answered in content instead of the forced tool call |

Two other candidates answered HTTP errors before generating and establish nothing:
`qwen/qwen3.7-flash` and `minimax/minimax-m2.7:free`.

This is what separates the configured model from every other hypothesis. A different model
produced a complete, terminated answer for the same document and schema in under fifteen seconds.

### Explicitly unknown

**Why** the model stops cannot be determined from client-side observation. Constrained decoding
failing inside the tool-argument grammar, an upstream generation fault, and a model defect all
produce these bytes. The earlier prompt-only run, which carried no structured binding and also
failed, weighs against structured decoding being the whole story — but its symptom (44,944
reasoning characters against the 120-second absolute deadline) is not this symptom, so it is not
evidence about this failure. This stays unknown rather than receiving an invented explanation.

### Reproduction pointers for the repair (#233)

```sh
pnpm exec tsx scripts/person-research-benchmark.mts \
  --mode fixed-documents --pipeline expanded --people achim-steiner --out <dir>
```

Reproduced on every one of six consecutive runs. The per-person `*.operation.json` under `<dir>`
carries the extraction attempts, and each `observed.modelBoundary` now names its `upstreamServer`.

A second, independent cause of the same emptiness is visible in the same runs and is not this
one: for `cary-fowler` and `timnit-gebru` the reference documents are rejected at
`identity-unmatched` before any extraction, so those operations retain zero sources and make zero
model calls. That is a failure to use evidence already in hand, and belongs to #233 and #237
rather than to this boundary diagnosis.

## Correction: the model never stopped, the client did (issue #232)

**The named cause recorded in the previous section is wrong and is retracted.** It read the
absence of token deltas as the model ceasing to generate. It was the 30-second stream idle
ceiling aborting calls the model was completing.

This upstream does not stream tool-call arguments token by token. It emits an opening fragment,
buffers the rest of the generation, and delivers it in very few large deltas. The app's idle timer
measures the gap *between* deltas, so the gap grows with the size of the answer — and past thirty
seconds the client aborts a call that would have succeeded.

### The evidence that settles it

**1. Silence scales with output size.** Holding model, schema, binding, prompt and route fixed and
varying only how much of the reference document is supplied:

| Document characters | Outcome | Tool-argument characters | Completion tokens | Longest silence |
| --- | --- | --- | --- | --- |
| 200 | 3 claims | 2,686 | 798 | 10,253 ms |
| 600 | 7 claims | 5,017 | 1,434 | 17,472 ms |
| 1,500 | 9 claims | 8,943 | 2,379 | 26,960 ms |
| 3,000 | **aborted** | 0 | — | 29,814 ms |

The failure is not a cliff in the model. It is the moment a monotonically growing gap crosses a
fixed client ceiling.

**2. The same request succeeds when it is not streamed.** The identical body with `stream` removed
returned 21,369 characters of valid tool-call JSON, `finish_reason: tool_calls`, 5,535 completion
tokens, in 104 seconds. The model completes this task.

**3. Raising only the idle ceiling makes it succeed.** With `MODEL_STREAM_IDLE_TIMEOUT_MS` raised
from 30,000 to 110,000 and nothing else changed, the full-document extraction succeeded three times
out of three — 19, 19 and 18 claims, valid JSON, `tool_calls` and `[DONE]` observed, longest
silences of 66,796, 54,050 and 62,643 ms. The override was reverted immediately; it is a
falsifiable test, not a proposed fix.

The eleven characters were never a stopping point. They were the first delta; everything else was
sitting in the upstream's buffer waiting for a client that had already given up.

### What this re-explains

- **Filler answered, the real document did not.** Filler yields an empty result set, a small
  answer and a short gap. Nothing to do with document content as such.
- **The trivial 126-byte schema also stalled.** It was mid-answer in one buffered delta. Schema
  size was never the variable — which is why the bisection from 7,897 bytes down to 126 bytes
  changed nothing.
- **`response_format` and `prompt_only` behaved differently.** Those bindings stream content
  incrementally on this route (longest silence 2.9 s and 11.2 s), so the idle ceiling never fires;
  they hit the 120-second absolute ceiling instead, having produced 16,531 and 9,668 characters.
  The binding mattered because it changes how the upstream chunks its output, not because tool
  calling is broken.
- **Wafer and NextBit both showed it.** Both buffer. The route was never the variable either.

### Re-reading the 33-model survey

Every model at or below the configured model's price was run against the same request, serially so
that a timeout means the model rather than contention. Sorting by mechanism rather than by
pass/fail:

| Mechanism | Signature | Models |
| --- | --- | --- |
| Client idle ceiling aborted a working model | silence 29.7–30.0 s | `z-ai/glm-5.3-flash`, `~z-ai/glm-flash-latest`, `openai/gpt-oss-120b`, `google/gemma-3-12b-it`, `inclusionai/ling-3.0-flash-fin`, `mistralai/mistral-small-3.2-24b-instruct`, `nvidia/nemotron-3-ultra-550b-a55b:free` |
| Genuinely slow; hit the 120 s absolute ceiling while actively generating | low silence, large reasoning or tool output | `nvidia/nemotron-3-super-120b-a12b:free`, `nvidia/nemotron-3.5-lightning:free`, `nex-agi/nex-n2-mini`, `~deepseek/deepseek-v4-flash-latest`, `deepseek/deepseek-v4-flash-0731`, `qwen/qwen3-30b-a3b-instruct-2507` |
| Ignored the forced tool call and answered in content | `finish: stop`, `[DONE]`, zero tool calls | `cohere/north-mini-code:free`, `openai/gpt-oss-20b` |
| No endpoint for these parameters | HTTP 404 before any generation | 7 models |
| Request rejected by the upstream | HTTP 400 from Google AI Studio | `google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free` |
| Completed the full contract as-is | valid tool call, `tool_calls`, `[DONE]` | `upstage/solar-pro4` (38 claims), `inclusionai/ling-3.0-flash-fin:free` (18), `mistralai/mistral-nemo` (14), `inclusionai/ling-3.0-flash-sante:free` (13), `inception/mercury-2.5-preview` (8), `inclusionai/ling-3.0-flash` (8), `meta-llama/llama-3.1-8b-instruct` (4), `nvidia/nemotron-3-nano-30b-a3b` (2) |

Only the third and fifth groups are model or upstream properties. The first is ours.

An earlier survey of the same models run four-at-a-time reported `upstage/solar-pro4` failing at
120 s; serially it completes in 85 s with 38 claims. Concurrency was confounding the measurement,
and that earlier ranking should not be used.

### Still unknown

Why this upstream buffers tool-call arguments rather than streaming them, and whether it is a
property of the upstream, of tool-call decoding, or of OpenRouter's normalisation, cannot be
determined from the client. It does not need to be: the client's job is to tell a buffering
upstream from a dead one, and the observations above give it the means.

## Performance and endpoint diagnosis (issues #232, #233)

Measured by calling the API directly with the exact captured production body, so no client ceiling
truncates the measurement. Shape only: token counts, character counts, timings, delta cadence.

### Why generation takes so long

Two factors multiply.

**The answer is large.** One document extraction asks for 4,700–5,400 output tokens — 18–20 KB of
JSON.

**The configured model is slow.** `z-ai/glm-5.3-flash` generates at **24–28 tokens/second** on the
routes that serve it. Five thousand tokens at that rate is roughly **200 seconds**, which is past
the 120-second absolute ceiling before anything goes wrong. Measured totals were 166,908 ms and
227,426 ms.

Models at or below the same price are an order of magnitude faster on the identical request:

| Model | tokens/s | Total | Claims | Deltas | Max gap |
| --- | --- | --- | --- | --- | --- |
| `inception/mercury-2.5-preview` | 317.8 | 20,554 ms | 10 | 13 | 5,917 ms |
| `inclusionai/ling-3.0-flash-fin:free` | 281.1 | 42,905 ms | 32 | 2,310 | 4,114 ms |
| `z-ai/glm-5.3-flash` (configured) | 24–28 | 166,908 ms | 19 | 39 | 139,794 ms |

**A quarter to a third of every answer is field names.** Parsing completed answers and counting
characters by role:

| | `ling-3.0-flash-fin` (32 claims, 31,819 chars) | `mercury-2.5-preview` (10 claims, 8,576 chars) |
| --- | --- | --- |
| Field names | 8,316 (26%) | 3,001 (35%) |
| Null and empty scaffolding | 580 (2%) | 212 (2%) |
| Punctuation | 2,672 (8%) | 963 (11%) |
| Substance | 20,251 (64%) | 4,400 (51%) |

The dossier contract does not require its wire field names to be its domain names. Shortening them
and mapping back is a contract-preserving change worth roughly a quarter of every extraction's
output tokens.

### Why calls stall

Delta cadence, not model behaviour. Same model, same request, different routes:

| Route | Deltas | Time to first token | Max gap | Answer |
| --- | --- | --- | --- | --- |
| NextBit | **1** | 56,694 ms | 56,694 ms | 18,797 chars |
| Wafer | 39 | 1,048 ms | 139,794 ms | 18,124 chars |
| `ling` / Novita | 2,310 | 4,114 ms | 4,114 ms | 31,819 chars |
| `solar-pro4` / Upstage | 6,821 | 2,309 ms | 2,309 ms | 28,257 chars |

NextBit delivers the entire answer in **one delta** after 57 seconds of silence. Our idle ceiling
measures the gap between deltas, so it kills exactly these routes. Deltas per answer is a clean
signal for whether a route streams incrementally.

### Why model endpoints do not work

**Our own routing block causes most of it.** `provider: { require_parameters: true }` produces
`HTTP 404 — No endpoints found that support the provided 'tool_choice' value`. Removing only that
block, the same models answer HTTP 200 in under a second:

| Model | With `require_parameters` | Without |
| --- | --- | --- |
| `minimax/minimax-m3:free` | 404 in 26 ms | 200 in 888 ms |
| `qwen/qwen3.7-flash` | 404 in 29 ms | 200 in 1,681 ms, `finish: tool_calls` |

Their endpoint metadata declares both `tools` and `tool_choice`, so the router is rejecting the
specific `tool_choice` *value* — a named function — which `require_parameters` cannot express. Two
things compound it: `readDeclaredParameters` unions `supported_parameters` across every endpoint,
so `forced_tool_call` is declared when no single endpoint supports the whole body; and a routing
404 is terminal, because the binding step-down ladder recognises a refusal only by the binding's
name and a no-endpoints failure names none.

**A Gemini-family model reached through OpenRouter gets a schema it cannot accept.** Google AI
Studio answers `INVALID_ARGUMENT` to the full 7,897-byte schema and 200 to a trivial one. The
codebase already has `geminiWireSchema` with `stripUnsupportedKeys`, but applies it only to the
`gemini` provider, not to Gemini-family models routed via OpenRouter.

**The rest are ordinary capacity facts**: HTTP 429 from DeepInfra, Makora, CoreWeave, Fireworks and
DigitalOcean; and several endpoint tags are not valid `provider.order` values, answering
`No endpoints found` when pinned.

### Why tool calls do not work

Two unrelated causes that the old pass/fail survey merged.

Most were the `require_parameters` 404 above — the tool call was never attempted.

Genuinely, `openai/gpt-oss-20b` and `cohere/north-mini-code:free` answer `finish_reason: stop` with
zero tool calls even when `tool_choice` names a function, and they do it with a trivial one-property
schema too, so it is not schema-related. They complete the task in content instead — 5,917 and
14,378 characters with `[DONE]` — and the boundary classifies that `unusable_shape` and stops. The
existing step-down ladder to `response_format` or `prompt_only` would recover both.

### Other things now known

- **Prompt caching already works.** A repeat call reported `prompt_tokens 4932, cached_tokens 4928`
  — 99.9% cached. There is no lever here, but it is not broken either.
- **Reasoning is not the configured model's cost**: 11–15 reasoning tokens per extraction. It is
  overwhelmingly the cost for others — `~deepseek/deepseek-v4-flash-latest` 161,416 reasoning
  characters, `nex-agi/nex-n2-mini` 125,418, `nvidia/nemotron-3-nano-30b-a3b` 109,202 — all of which
  hit the absolute ceiling while actively generating.
- `inception/mercury-2.5-preview` spends 4,840 of 4,938 tokens on reasoning and still finishes in
  20 seconds.
- `qwen/qwen3.7-flash` returns **two** tool calls for one forced function; the reader takes the
  first, which is correct but worth knowing.

### Ranked performance work, by measured payoff

1. **Stop aborting working generations.** Distinguish a buffering upstream from a dead one instead
   of timing out on inter-delta gaps. Recovers seven models including the configured one.
2. **Stop sending `require_parameters: true` blind, and step down on a routing 404.** Recovers seven
   models at the cost of one retry.
3. **Shorten wire field names and map them back.** Same contract, roughly 25–30% fewer output
   tokens on every extraction.
4. **Select model and route on measured throughput.** A tenfold speedup is available at or below the
   current price.
5. **Strip unsupported schema keywords for Gemini-family models routed through OpenRouter.**
6. **Step the binding down when an upstream ignores forced tool choice** rather than failing.

## Route control: what OpenRouter accepts, measured (issue #233)

The remaining failure mode after the boundary repairs is route variance: one run in four still lost
a whole operation to the route it happened to land on. Resting a route that just failed needs a way
to name it on the next call, so this section measures what the API accepts. Read-only listings plus
four-token completions; no extraction, no answer text retained.

### The stream names a route by its display name

`GET /api/v1/models/z-ai/glm-5.3-flash/endpoints` returns 23 endpoints carrying both a
`provider_name` and a `tag`, and the two differ: `Sail Research` / `sail-research/fp8`,
`Z.AI` / `z-ai/fp8`, `NextBit` / `nextbit/fp8`, `DeepInfra` / `deepinfra/fp4`. The `provider` field
that every streamed chunk carries — the one recorded as `ModelBoundaryDiagnostic.upstreamServer` —
is the **display name**: a minimal completion reported `"provider": "Parasail"`, whose tag is
`parasail/fp8`.

### `provider.only` and `provider.ignore` accept that display name verbatim

The question this settles is whether a route observed in a diagnostic can be named back to the
router without a mapping. It can. Pinning with `only`, all three forms resolve to the same route:

| Sent | Served by |
| --- | --- |
| `Parasail` | Parasail |
| `parasail` | Parasail |
| `parasail/fp8` | Parasail |
| `Sail Research` | Sail Research |
| `sail-research` | Sail Research |
| `Z.AI` | Z.AI |
| `Io Net` | Io Net |

Names with spaces and dots resolve, so the router normalises them itself. And `ignore` honours the
same names: ignoring 21 of the model's 23 routes by display name, alongside `sort: "throughput"`,
left `Parasail`, `Parasail` and `Modal` serving three consecutive calls. An unrecognised name
(`not-a-real-provider`) is accepted and has no effect rather than being refused, so a rest can fail
only by doing nothing.

Normalising display names to slugs was therefore not needed — which is fortunate, because it does
not work: applying `lowercase, non-alphanumeric runs to hyphens` across all 106 providers in
`GET /api/v1/providers` disagrees with the real slug for 13 of them (`Moonshot AI` / `moonshotai`,
`AtlasCloud` / `atlas-cloud`, `Google` / `google-vertex`, `Thinking Machines` / `thinkingmachines`
among them). Naming a route the way the stream named it avoids the question entirely.

### Correction: those endpoint tags were valid all along

The read-only upstream route inventory above recorded that `gmicloud`, `novita`, `z-ai`,
`streamlake` and `siliconflow` were "not valid `provider.order` tags" because pinning them answered
`No endpoints found`. That is wrong and is retracted. They are the exact base slugs of five of this
model's endpoints, and each serves the model when pinned today. The refusal was capacity or the
`require_parameters` interaction diagnosed later in this document, both of which are answered by
`No endpoints found` too — not a naming fault.

### The skipped rung was real

The union of `supported_parameters` across all 23 endpoints is
`response_format, structured_outputs, tools, tool_choice, …`. So on the configured model, a request
that prefers `forced_tool_call` and fails had a declared `response_format` rung available and
stepped past it to prompt-only. That is the step-down order defect, confirmed against the
declaration rather than inferred from the run.

## End-to-end verification of the route controls, six serial runs (issue #233)

`--people achim-steiner`, fixed-documents, expanded pipeline, run one at a time so that a timeout
means the route rather than contention. Every attempt's `observed.modelBoundary` names the route
that served it.

| Run | Attempts, in order | Claims | Elapsed |
| --- | --- | --- | --- |
| 1 | DeepInfra timeout 90 s (10 KB) → CoreWeave timeout 300 s (1.49 MB) | 0 | 316 s |
| 2 | DeepInfra timeout 90 s (9 KB) → Wafer timeout 90 s (11 KB) | 0 | 211 s |
| 3 | overrun 2.0 MB → response_format timeout 300 s (0 B) | 0 | 321 s |
| 4 | DeepInfra timeout 90 s → Together overrun → Parasail overrun → Z.AI overrun | 0 | 320 s |
| 5 | Together overrun → Parasail overrun → Morph timeout 300 s (810 KB) | 0 | 336 s |
| 6 | Together overrun → Parasail timeout 300 s (1.58 MB) | 0 | 336 s |

**Zero of six produced a claim**, against three of four the day before. The three controls work
mechanically and none of them was enough.

### What the runs establish

**Rests reach the wire and re-route.** No route was asked twice in one run. DeepInfra failed first
in runs 1, 2 and 4 and never served the retry. Together, Parasail and Z.AI were each rested in turn
in run 4, and each subsequent attempt landed somewhere new.

**The ladder steps where it could not before.** Run 4 walked `forced_tool_call` →
`response_format` → `prompt_only`. Before the change the first failure went straight to
`prompt_only` and the run had two attempts where it now has four.

**The overrun ceiling frees budget.** Runs 4 and 5 fitted three and four attempts into one
300-second operation, where a runaway previously consumed it whole.

### What they falsify

**The ceiling's first threshold was wrong, and it was measuring the wrong thing.** It counted
bytes off the wire at two megabytes, justified as sixty times the largest answer ever measured
(31,819 characters). That comparison is invalid: a route streaming one token per SSE event spends
roughly 200 bytes of envelope per token, so two megabytes of wire is about ten thousand tokens,
inside what a real answer to this contract costs. Runs 1 and 6 show legitimate generations at
1.49 MB and 1.58 MB when their own time ran out, and runs 3 through 6 show three different routes
stopping at exactly 2,000,xxx bytes. The ceiling now counts answer characters — content, tool-call
arguments, and reasoning by length — at 250,000, and ADR-0070 records why. **The threshold is not
yet verified against live data.**

**A route name with a space could never be rested.** `safeName` and the durable diagnostic
sanitizer both rejected any name containing a space, so `Sail Research` and `Io Net` arrived as
`[unnamed]` — visible in run 3, which rested nothing usable. Route names now permit interior
spaces, which is what `provider.ignore` takes back.

### What is still unexplained

The operation's 300-second budget is the binding constraint, and on these routes this model does
not fit inside it once anything is wasted. Two of the six runs spent 90 seconds on a buffering
route before the first token; the configured model then needs roughly 200 seconds of generation at
its measured 24-28 tokens/second. Resting a bad route helps the next attempt, but the attempts
share one deadline (ADR-0066), so the rest arrives with less budget than the work needs.

Rests are also per process, and the benchmark starts a fresh process per run with one extraction in
it — so nothing a run learns can help the next one. The app is a long-running process and does
accumulate them; the instrument used to measure the fix is the one place the fix cannot show.

The untried lever is routing on measured speed rather than only away from failure:
`provider.preferred_min_throughput` is an OpenRouter routing field, and the measured spread on this
model is 24-28 tokens/second on the routes that lose the operation against 66-75 on others.
