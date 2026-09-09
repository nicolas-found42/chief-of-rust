# Bounded extraction diagnostics

These are diagnostic controls, not full benchmark acceptance. Each uses the same small
Cary Fowler Senate testimony excerpt and one independently authored reference fact, in an
isolated temporary Workspace. The diagnostic lookup explicitly supplies the public Senate
URL to isolate extraction from identity discovery. The canonical 30-person lookup/reference
corpus was not weakened. The model remains OpenRouter `z-ai/glm-5.3-flash`; credentials and
reasoning content are absent. The production 120-second absolute/30-second idle ceilings
were held fixed.

| Control | Run | Report status | Research conclusion | Published claims | Recovered | Failure |
| --- | --- | --- | --- | --- | --- | --- |
| Default binding, effort and temperature | `216c0ddd0a8f2ad8` | failed | interrupted | 0 | 0 / 1 | Research interrupted before the operation completed. |
| Diagnostic low reasoning effort | `8797213e4db55ba3` | failed | interrupted | 0 | 0 / 1 | Research interrupted before the operation completed. |
| Diagnostic temperature 1 | `9c665b752efeb311` | failed | interrupted | 0 | 0 / 1 | Research interrupted before the operation completed. |
| Diagnostic forced-tool declaration; applies to research and judge | `bf64b097d0b41604` | failed | completed | 1 | 0 / 1 | Judge failed: openrouter: a model call was in flight when the request ceiling fired (model z-ai/glm-5.3-flash, binding forced_tool_call, HTTP 200, 41999 bytes, ceiling 30000ms) |

The forced-tool control filters the metadata declaration only in a temporary fetch wrapper
so the real production binding selector and parser both choose a forced tool call. It is a
diagnostic configuration, not an unmodified production acceptance run. It completed research
with one claim but its semantic judge failed, so the report remains failed.

A separate one-field `name` schema request through the same configured production model
boundary completed in 827 ms and returned Cary Fowler. This establishes basic provider
connectivity; it does not establish dossier extraction quality. Low reasoning effort and
temperature 1 did not fix the extraction timeout and were not adopted in production.

A preliminary wire-only tool override was invalid because it changed the request without
changing the binding parser. Its empty-answer diagnostic is not evidence against tool
calling and is excluded from this control table. The unchanged raw report remains at
`/private/tmp/issue-228-small-fixed-tool/` for session debugging.

## Bounded retry and completed candidate smoke

- `fixed-documents-expanded-66ed88fb3d6a061d`: failed; successful extraction and fact judging,
  but usefulness judging reached the original deadline. No retry occurred.
- `fixed-documents-expanded-39e8f583d614ad67`: completed; valid production extraction, complete
  semantic judging, one of one dated reference facts recovered, no critical integrity findings.
  All three requests succeeded first try with declared tool binding; no retry occurred. This
  tiny diagnostic corpus is not the canonical 30-person collection and cannot establish full
  acceptance or be compared to the full live runs. The generated dossier differs from the prior
  run, so this is an end-to-end candidate success, not an exact-input binding comparison.

## Full Achim extraction controls

The `issue-228-achim-*` reports are explicitly diagnostic variants on the canonical Achim input,
not complete benchmark populations. Temperature 1, temperature 1 with low reasoning, a reduced
core-claims schema, and prompt-only binding did not recover extraction. The reduced schema and
synthetic prompt-only capability declaration are never acceptance configurations. Prompt-only
excluded judges entirely. Fireworks-only routing returned immediate upstream HTTP 429. These
controls did not change production configuration or justify adopting their variants.

The two `issue-228-glm-*-metadata.json` files contain allowlisted anonymous official OpenRouter
metadata only. They confirm multiple same-model upstream routes and supported effort choices;
missing latency/default/token-budget fields are preserved as unavailable, not inferred.

Additional retained Achim controls also failed: Together-only routing returned HTTP 429;
`max_tokens: 8192` plus low reasoning stalled on both NextBit attempts; DeepInfra accepted both
requests but stalled without an answer; and a first-1,000-character document window stalled on
Wafer then reached the original deadline on Io Net. The smaller window preserved the full
retained source and explicitly marked the sent portion partial. None of these settings was
adopted. See the detailed extraction-boundary diagnosis for timings and limitations. These
reports contain sanitized diagnostics, not model reasoning or configuration secrets.

The final same-model route control pinned the model maker's currently advertised `z-ai/fp8`
endpoint. It returned HTTP 404 before any model output or upstream attribution; the public
metadata and sanitized operation/report are retained here. The newly documented SGLang serving
defect resembles observed symptoms but has not been attributed to any tested upstream. No
production request or routing change was justified by that finding.

The `issue-228-wikipedia-challenge-{probe,after}.json` files record a separate, confirmed source
reader defect and its repair. The same normal 200 article response was previously classified as
a challenge solely because Wikipedia's editing JavaScript mentioned `hcaptcha`; after the repair
it is not. `issue-228-wikipedia-reader-after.json` verifies that the production anonymous reader
retained 15,238 biography characters and delivered them to a controlled extraction observer.
That source-boundary check made no model call and is not a quality benchmark. The fresh full
`reader-fixed-expanded-2026-09-06` run measures the effect on real research separately.

The `issue-228-achim-zai-auto*` controls account for Z.AI's endpoint declaring automatic tool
selection but not forced-function selection. Automatic selection reached Z.AI with HTTP 200,
but streamed reasoning activity until the unchanged 120-second deadline without an answer or
tool result. A low-reasoning follow-up received heartbeat comments only on both bounded attempts.
The `.observations.json` files retain activity counts, never reasoning content. These overrides
were diagnostic only and were not adopted in production; the full schema and configured model
remained unchanged.
