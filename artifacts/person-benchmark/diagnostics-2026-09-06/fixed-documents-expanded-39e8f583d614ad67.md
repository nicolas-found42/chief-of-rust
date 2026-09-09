# Person Research Benchmark — fixed-documents

Run `39e8f583d614ad67` · **completed** · Every selected Benchmark Person was evaluated.
Evaluation execution: completed; 1 / 1 selected people fully assessed. Research failures remain reported separately.

## Conditions

| Field | Value |
| --- | --- |
| Corpus version | ead8f30f1cf6c27c |
| Pipeline | expanded |
| Research provider/model | openrouter · z-ai/glm-5.3-flash |
| Judge provider/model | openrouter · z-ai/glm-5.3-flash |
| Judge version | 2026-09-06.4 |
| Prompt version | 2026-09-06.4 |
| Network | fixed-documents |
| Started | 2026-09-06T10:00:35.211Z |
| Finished | 2026-09-06T10:01:32.277Z |
| Research settings | providers=full bundle, mergedLimit=60, readers=html, text, documents, feeds, captions, social, records, planner=false, readConcurrency=4, profileCalls=60, profileMilliseconds=900000, modelRetryPolicy=One same-binding idle/transport retry inside the original deadline; extraction and benchmark judges only, usageAccounting=Logical request text and returned answer characters; excludes retried wire payloads, judgeBindingPreference=forced_tool_call when model-declared; default otherwise, extractionBindingPreference=forced_tool_call when model-declared; default otherwise |
| Measured usage | 7882 input characters, 5706 output characters; tokens and cost unavailable from the model boundary |

## Per person

| Person | Industry | Footprint | Recovered / facts | Ambiguous | Critical | Overclaims | Claims | Sources | Families | Conclusion |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cary-fowler | agriculture | video-first | 1 / 1 | 0 | 0 | 1 | 1 | 2 | 1 | completed |

## The four measures, kept separate

- **Factual reliability** — 2 of 2 citations verify against their retained source version; 0 critical integrity findings; 1 judged overclaims, of which 0 are wrong-person attributions.
- **Completeness** — 1 of 1 reference facts recovered, 0 partially, 0 left ambiguous for review.
- **Absolute richness** — 1 published claims over 2 retained sources; reported beside completeness, never folded into it.
- **Meeting-preparation usefulness** — mean understanding 1.00 of 3, judged with cited evidence.
- **Operational reliability** — 1 of 1 operations reached their own completion conditions.

## By group (with denominators)

Reference-source-family groups are cohorts of people whose reference documents include that family; their whole-person recovery is not a production source contribution.

| Dimension | Group | People | Recovered / facts | Ambiguous | Critical | Overclaims |
| --- | --- | --- | --- | --- | --- | --- |
| industry | agriculture | 1 | 1 / 1 | 0 | 0 | 1 |
| role | Agriculturalist; co-founder of the Svalbard Global Seed Vault | 1 | 1 / 1 | 0 | 0 | 1 |
| footprint | video-first | 1 | 1 / 1 | 0 | 0 | 1 |
| language | en | 1 | 1 / 1 | 0 | 0 | 1 |
| region | Washington, D.C., United States | 1 | 1 / 1 | 0 | 0 | 1 |
| reference-source-family | professional-records | 1 | 1 / 1 | 0 | 0 | 1 |

## Actual source-family contributions

These counts follow actual retained source versions and cited claims; multiple retained versions of one URL are not independent sources. Recovered facts exclude critical-invalid citations and judged overclaims; a faithfully recovered self-report remains a self-report. Exclusive recovery means the matched claim cites only that family, not that the family was causally necessary or independent of every other source. A fact may appear in multiple families; do not add family recovery totals.

| Person | Actual family | Retained / cited versions | Cited claims | Recovered / person's facts | Exclusive recovered |
| --- | --- | --- | --- | --- | --- |
| cary-fowler | professional-records | 2 / 1 | 1 | 0 / 1 | 0 |

The JSON report retains each contributing source URL, hash, upstream index, cited claim IDs and recovered reference-fact IDs, including retained sources that contributed no claims.

## Observed judge wire attempts

| Assessment | Wire attempts observed | Recovery attempts initiated | Final failed attempts |
| --- | --- | --- | --- |
| Individual people | 2 | 0 | 0 |
| Collection scenarios | 0 | 0 | 0 |

The JSON retains correlated, sanitized attempt diagnostics even when a later attempt succeeds. These are observed wire attempts, separate from logical model invocations; uninstrumented boundaries do not supply wire counts. Character usage measures logical request text and returned answers, excluding retried wire payloads.

## Remaining misses

These are the acceptance targets for follow-up source and extraction work. A miss marked `beyond-current-coverage` was authored knowing the application cannot reach it today; it stays in the reference.

| Person | Fact | Requirements | Acquisition | Why it is still missing |
| --- | --- | --- | --- | --- |

