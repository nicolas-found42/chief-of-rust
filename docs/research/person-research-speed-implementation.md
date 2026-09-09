# Person research speed implementation

Implements the concrete recommendations in
[the speed research](person-research-speed-2026-09-09.md).
The condition change is recorded in [ADR-0075](../adr/0075-person-research-reuses-source-versions-and-pipelines-work.md).

| Recommendation | Implementation | Verification |
| --- | --- | --- |
| Tracking aliases and exact reuse | Conservative Bing destination normalization; path case and meaningful query parameters preserved; observed redirects registered; exact extraction work coalesced within an operation and identity revision. | Alias, changed-text and concurrent-copy fixtures. |
| Provider-specific queries and typed results | ORCID name fields, known-organization ROR queries, artist-name catalogue queries; provider/entity metadata preserved; provider query cache and in-flight reuse. | Concurrent structured-query fixture and anonymous ORCID probe. |
| Fetch/extraction pipeline | Reads feed extraction as ready; global model capacity four, global source reads eight, per-host capacity two with slower/failing hosts reduced to one; per-operation reader allowance retained. | Slow-read barrier, concurrent checkpoint, lifecycle and process-restart suites. |
| Coverage/novelty expansion | Exact supported-statement novelty; bounded yield/latency adjustment to ranking; up to `quietRounds` planning attempts for unchanged evidence and coverage context. | Existing completion/selection suites, duplicate-evidence planner fixture. |
| Independent benchmark queues | Research workers release their slots before judging; judge concurrency remains bounded; both queues drain on failure. | Blocked-judge and output-failure fixtures. |
| Relevant passage selection | Opening context plus relevant original windows for documents over 60k; at most four parts/60k, exact source offsets, full retained original. | Relevant late-passage fixture with exact slicing and budget assertions. |
| Local organization lookup | Optional ROR v1/v2 dump, exact unambiguous aliases, SHA-256 data version, normal provider fallback on miss/ambiguity. | Local multilingual alias fixture with forbidden network access. |
| Quality-versus-time measurement | Optional reassessment at specified publication cutoffs, using the ordinary semantic judge and attested retained evidence. | Timeline reassessment fixture; original operation verdict preserved. |

The anonymous ORCID probe on 2026-09-09 returned HTTP 200 for
`given-names:Josiah AND family-name:Carberry`, with two matches and one requested
result. The earlier `credit-name`-only probe was a clean empty result. The
implementation uses name fields plus an alternate credit-name clause; it adds
no credential or paid data acquisition route.

To use an already installed ROR JSON dump, set `PERSON_RESEARCH_ROR_DATA` to its
absolute path before starting the application or benchmark. No dump is downloaded
automatically. Startup validates the bounded file, and benchmark conditions record
its content hash. Replace the file and restart to adopt a new version. Without
the variable, ROR uses the existing anonymous network route. Local misses are not
negative evidence about a person's employment.

For Docker Compose, place the dump at `workspace/ror-data.json` and start with
`PERSON_RESEARCH_ROR_DATA=/app/workspace/ror-data.json docker compose up -d`.
The path names the file inside the existing container mount. A native benchmark
uses the host's absolute file path instead.

To assess retained revisions at the research cutoffs:

```sh
pnpm exec tsx scripts/person-research-benchmark.mts \
  --reassess /absolute/path/to/report.json \
  --evidence-workspace /absolute/path/to/retained-evidence \
  --timeline-minutes 1,2,3,5,15 \
  --out /absolute/path/to/new-output
```

This adds paid model judging at each cutoff under the configured judge, then
performs ordinary final reassessment. Separate `timeline-*.json` artifacts contain
the cutoff, selected dossier revision and assessment. A timed snapshot does not
carry an inferred successful research conclusion. Private evidence and mismatched
report/evidence lineage remain refused by the reassessment boundary.

The paper-level alternatives remain experiments rather than production defaults:
fuzzy deduplication, learned bandit allocation and a multilingual reranker were
explicitly conditional in the research. The implementation uses exact reuse and
transparent deterministic ranking first. Model changes, shorter timeouts and
relaxed completion thresholds are not part of this change.

Local verification of `c9cf65d` on 2026-09-09: `pnpm run check` passed 208 files and 2,388
tests plus static checks; Playwright passed 82/82. Coverage passed the existing
floors: statements 85.39%, branches 75.02%, functions 87.91%, lines 87.71%.
These checks establish implementation behavior; they are not a measured live
speedup or a new 30-person acceptance result.

The review follow-up removes a redundant raw-URL check during canonical resume,
makes the organization-result continuation explicit, latches a reached provider
outage against late successes, and retains only the best passage candidates
while scanning. The full local check passes 2,391 tests after these regressions.
The live smoke run starts at `c9cf65d`; it is a fresh operation, and the follow-up
preserves its passage-selection and failure-policy semantics.
