# Making Person Research substantially faster

Research date: 2026-09-09. Requested by Nicolas during the post-#315 verification
of #239. Research performed in one agent, using Context Awesome for discovery,
gh_grep for implementation examples, and Firecrawl for primary documentation
and papers. This is a proposal and evidence record, not a change to the research
contract or authorization to replace the pinned acceptance conditions.

## Recommendation

Prioritize eliminating repeated and irrelevant work, then overlap the useful work.
Start with tracking-URL canonicalization and source-specific query construction;
follow with a bounded fetch/extract pipeline and evidence-based expansion.
Changing models or shortening the timeout alone does not address the observed
failure to finish.

Proposed product targets, to validate rather than advertise: first useful evidence
within 60 seconds, a useful dossier within 2–3 minutes, and a substantially lower
completion latency without losing supported reference recovery. The current run
already publishes its first claims within a minute, but those claims have not
been assessed at that early checkpoint. A useful initial dossier, completed
research, and a completed benchmark assessment are separate measurements.

## What the current run actually establishes

Run `ef11370435786961` started at approximately 03:08:43 UTC on 2026-09-09 from
`59550c4`, the exact #315 merge commit. This section is a fixed snapshot of the
first four people, not a claim about the whole 30-person population. The run
continues independently of this research note. Its launch and subsequent verdict
belong on [#239](https://github.com/nicolas-found42/chief-of-staff-demo/issues/239#issuecomment-5595196957).

Conditions: live-discovery, expanded, Mercury for research/planning, GLM-5.3-flash
for judging with high reasoning effort, four operations, four readers, 180 model
calls and 900,000 milliseconds per operation. Browser rendering was not enabled;
evidence retention was enabled. The isolated checkout passed `pnpm run check`
(206 test files, 2,376 tests and static checks). No production implementation was
changed for the run.

Timestamped dossier revisions give this early-publication curve:

| Person | First claims | Claims at 1 minute | At 2 minutes | At 5 minutes |
| --- | ---: | ---: | ---: | ---: |
| Achim Steiner | 37 seconds | 17 | 41 | 58 |
| Ana Botín | 42 seconds | 18 | 22 | 84 |
| Anders Danielsson | 37 seconds | 12 | 18 | 59 |
| Arvind Krishna | 37 seconds | 15 | 35 | 122 |

These counts describe published assertions, not independently established utility.
The final first-four records are:

| Person | Research minutes | Conclusion | Recorded requests | Rounds | Model metric records | Median / p95 call seconds | Final claims |
| --- | ---: | --- | ---: | ---: | ---: | --- | ---: |
| Achim | 15.90 | bounded | 800 | 91 | 54 | 4.7 / 7.1 | 127 |
| Ana | 15.02 | bounded | 929 | 105 | 53 | 4.7 / 7.3 | 127 |
| Anders | 15.01 | bounded | 550 | 59 | 81 | 4.6 / 6.5 | 169 |
| Arvind | 15.31 | bounded | 570 | 60 | 95 | 4.6 / 6.5 | 280 |

Research elapsed time excludes judging for these first four, which began
immediately. The nominal 15-minute backstop is not an exact process termination
deadline: in-flight work can take the observed elapsed time above it. The
`requests` field is the operation's accounting, not a census of every downstream
HTTP request inside a search-provider fan-out. Call timings above are successful
logical `model-call-metrics` records, including any time inside their logical
call; they do not establish the distribution of every failed wire attempt.

All four hit the wall-clock bound with pending work. Achim, Ana and Anders finished
judging, recovering 0/4, 2/13 and 0/8 reference facts respectively, with partial
matches recorded separately. Arvind's support/usefulness assessment failed on a
90-second silent-response ceiling. His zero credited recoveries cannot be read
as an independent quality assessment. Thus 703 published claims across four
people do not establish that the time was well spent.

The earlier retained run `004573b4dbe063a6` had a 15.2-minute median research
duration and zero completed operations across 30 people. It predates #315 and
is context, not a controlled comparison against this run.

Evidence locations: per-person and operation JSON files under
`artifacts/person-benchmark/live-discovery-expanded-ef11370435786961*` in the
`chief-of-staff-239-verdict` checkout, plus the run's retained evidence bundle
when finalized. First-publication times come from the first nonempty dossier
revision minus the job's `startedAt`; timed claim counts use the latest revision
at or before each cutoff. Final durations and counts come from the per-person
`operational` and `richness` fields; call percentiles use the sorted logical-call
duration observations (p95 index `floor((n-1)*0.95)`).

## 1. Remove tracking aliases and repeated extraction first

**Observed:** Anders's operation made 11 extraction calls to one Yahoo article
through distinct Bing news tracking URLs. It also made nine calls to one Nasdaq
target through aliases. Across the first four operations, groups containing
multiple URL aliases accounted for 20, 11, 56 and 35 extraction calls respectively.
Those groups consumed approximately 186, 52, 266 and 168 seconds of logical-call
time. These are affected groups, not all avoidable time: one extraction per
genuine content version remains necessary, and multipart extraction may require
several calls.

The retained Yahoo records contain 11 distinct URL strings and two text hashes,
with repeated copies of the dominant text. Do not equate every source-store
record with a separate network fetch: retention/publication can write multiple
records. The extraction attempt history is the evidence of repeated model work.

**Current code:** `LeadRegistry.normalizeTarget` strips fragments and some
tracking parameters but leaves Bing's changing `tid` and embedded destination.
`createPublicSearch` deduplicates exact result URLs. Consequently, the same
destination can keep arriving as a new lead. The normalizer also lowercases the
entire URL; a replacement should preserve case-sensitive paths and meaningful
query parameters. See [the pinned lead registry](https://github.com/nicolas-found42/chief-of-staff-demo/blob/59550c4/apps/server/src/person-profile/research-plan.ts)
and [search merge](https://github.com/nicolas-found42/chief-of-staff-demo/blob/59550c4/apps/server/src/source-adapters/search.ts).

**Proposal:** unwrap known search redirect formats at discovery, preserve original
discovery URLs as provenance, and key retrieval by a conservative canonical
destination. Register observed redirects as aliases after fetching. Reuse exact
text-version extraction inside the same identity/revision context, keyed by
source hash, parser/prompt/model versions and extraction configuration. Coalesce
simultaneous requests for the same key. Keep source versions, citations and
independence evidence distinct; identical copies are not independent corroboration.

gh_grep found precisely this Bing wrapper handling in
[Searx's Bing news engine](https://github.com/searx/searx/blob/master/searx/engines/bing_news.py).
It is prior art to understand, not a reason to copy AGPL code into this repository.
[Scrapy's request fingerprints](https://docs.scrapy.org/en/latest/topics/request-response.html#request-fingerprints)
and [Crawlee's request keys](https://github.com/apify/crawlee/blob/master/packages/core/src/request.ts)
show mature request-identity patterns. Exact deduplication should precede fuzzy
similarity. A study of main-content extraction and near-duplicate detection
found a precision/recall tradeoff, reinforcing the need to test thresholds rather
than treat similar text as identical evidence.
[Primary paper](https://arxiv.org/abs/2111.10864)

**First experiment:** replay saved discovery results containing changing wrappers;
prove one retrieval/extraction per unchanged destination/version, while changed
dates, content, identity and meaningful query parameters still produce new work.
Measure calls eliminated and recovery preserved. This is the strongest concrete
candidate for a focused first implementation ticket.

## 2. Ask each source a question it can answer

**Observed:** the first four operations recorded 1,819 `identity-unmatched`
failures. ORCID accounted for 836 and ROR for 411: together **68.6%**. Art Institute
pages contributed another 140. This is an observed rejection distribution, not
proof that every rejection was correct or that removing those sources would
improve quality.

The adapters pass the broad research query directly to ORCID `q`, ROR `query`,
and the artwork search endpoint. Their different entity types collapse into the
same title/URL/snippet interface. ROR results are organizations; repeatedly
retrieving them as candidate person documents is particularly suspect.
[ORCID adapter](https://github.com/nicolas-found42/chief-of-staff-demo/blob/59550c4/apps/server/src/source-adapters/providers/orcid.ts),
[ROR adapter](https://github.com/nicolas-found42/chief-of-staff-demo/blob/59550c4/apps/server/src/source-adapters/providers/ror.ts),
[record providers](https://github.com/nicolas-found42/chief-of-staff-demo/blob/59550c4/apps/server/src/source-adapters/providers/person-records.ts)

**Proposal:** represent discovery intent with identity signals, requested fact
type, known organizations, language and remaining coverage. Each provider builds
its native query and preserves entity type and original index in its result.
ORCID has explicit name and affiliation fields; ROR documents organization-name,
identifier and affiliation matching. Use the latter to resolve an organization
already evidenced in the operation. An organization match does not establish a
person's employment.
[ORCID search documentation](https://info.orcid.org/documentation/api-tutorials/api-tutorial-searching-the-orcid-registry/),
[ROR matching documentation](https://ror.readme.io/docs/matching)

The ORCID documentation describes token-based search while the repository records
historical anonymous success. Before depending on a revised route, reconcile its
current documented access with an anonymous probe and the existing source
eligibility contract. No keyed acquisition fallback is proposed here.

Preserve broad discovery across industries. Every source family remains eligible;
schedule it when its inputs and the evidence make the query meaningful. Audit
apparently authoritative rejected biographies before strengthening any prefilter:
the first-four rejection sample includes UNDP and Santander pages, so an aggressive
name-only gate could amplify existing false negatives. Aliases, diacritics,
transliteration and incomplete snippets need explicit coverage.

**Experiment:** compare existing versus structured queries on the same people and
sources. Measure fetched-but-unmatched rate, unique supported facts per 100
requests, missed positive identity matches, and source-family coverage. Start
with deterministic matching of explicit identifiers and metadata; evaluate a
small multilingual reranker only if simpler scoring is insufficient.

Context Awesome surfaced [ACHE](https://github.com/VIDA-NYU/ache), whose first-party
documentation separates page classification and crawl strategy. It is useful
design precedent, not a recommendation to replace the TypeScript runtime with Java.

## 3. Pipeline reads and extraction with bounded concurrency

**Code finding:** research awaits the entire `mapLimit(reads, readConcurrency, ...)`
batch, then iterates its results with `for (const entry of outcomes)`. Inside that
loop, document parts await model extraction one at a time. Four parallel readers
therefore do not mean four parallel extractions. A slow reader also delays
extraction of the other already-fetched documents.
[Pinned research loop](https://github.com/nicolas-found42/chief-of-staff-demo/blob/59550c4/apps/server/src/person-profile/research.ts)

**Proposal:** start identity validation and bounded extraction as each read becomes
ready. Use separate fetch and model limits, a bounded handoff queue, and the
existing serialized publication boundary. Preserve cancellation, archive/delete
fencing, identity revisions, budget reservations and per-part IDs. Checkpointing
currently has one `pendingSourceId`; concurrent extraction needs a durable set of
in-flight source/part work before this can be considered correct.

[p-map](https://github.com/sindresorhus/p-map#pmapiterableinput-mapper-options) supplies
an example of bounded concurrent mapping and backpressure. Its iterable emits
results in input order, so it is **not** automatically an as-ready scheduler:
put dependent processing inside each worker or use a completion-order queue to
avoid recreating the same waiting behavior. Existing repository helpers may be
sufficient; adopting a package is not the deliverable.

Recorded successful model-call time sums to about 266–454 seconds per person in
the first four. An idealized four-way overlap would remove at most about
200–341 seconds from that sequential component, before overhead and dependencies.
That is an illustration of available overlap, not a predicted wall-clock gain.
Faster execution can otherwise simply spend the remaining 15 minutes discovering
more material unless duplicate work and stopping behavior improve too.

**Experiment:** replay delayed reads and extraction responses, including one slow
read ahead of several fast reads. Measure first publication and total makespan,
then verify lifecycle behavior through the production composition seam. Follow
with a small live cohort to check provider contention. Do not multiply person,
reader and extraction concurrency without a global provider limit.

## 4. Make expansion earn its continued work

The current completion contract checks investigated coverage, dispositioned leads,
and quiet expansion. A round is not quiet when it produces evidence or grows the
pending list. Tracking aliases and low-value discoveries can therefore delay
completion even after substantial output. A fixed timeout is correctly reported
as `bounded`; changing the number cannot make it genuine completion.
[Completion policy](https://github.com/nicolas-found42/chief-of-staff-demo/blob/59550c4/apps/server/src/person-profile/research-policy.ts)

**Proposal:** prioritize expected *new supported coverage per unit of time*, using
identity relevance, evidence novelty, a specific coverage gap and observed source
latency/yield. Repeated equivalent claims and tracking aliases should not count
as progress. Retain an exploration allowance for alternative queries and source
families so a sparse first result cannot permanently exclude valuable evidence.
Record why each rejected or inaccessible lead ceased to be actionable.

[Crawl4AI's adaptive crawling](https://docs.crawl4ai.com/core/adaptive-crawling/)
uses coverage, consistency and saturation signals, with statistical and semantic
strategies. Its confidence thresholds are heuristics; they do not certify this
product's identity, citation integrity or completion requirements. Borrow the
observable gain signals, not its default stopping threshold.

A later experiment could allocate discovery effort with a contextual bandit using
observed useful yield and latency. A [CTI-focused crawling paper](https://arxiv.org/abs/2504.18375)
studies adaptive discovery with bandits and semantic relevance. That is an
interesting research direction, not evidence of a speedup for person dossiers.
Start with transparent deterministic scores before introducing learned scheduling.

**Experiment:** assess retained dossier snapshots at 1, 2, 3, 5 and 15 minutes under
one judge configuration. Plot supported reference recovery and distinct useful
coverage against time and cost, including identity errors and incomplete judging.
Claim count alone is not the stopping signal. Any material revision to what
`completed` means requires a deliberate update to ADR-0063/#239 before a new
acceptance run; do not retrospectively relabel this run.

## 5. Improve tail latency and reuse without hiding failures

Several supporting ideas are worthwhile after the first four priorities:

| Idea | Existing behavior / proposed difference | Evaluation |
| --- | --- | --- |
| Per-host scheduling | Search already has cooldowns. Add or verify fetch-level host limits and latency-aware scheduling shared across operations; do not let a slow host occupy all useful work. | p50/p95 retrieval latency, rate-limit incidence, queue idle time. |
| Exact content and in-flight reuse | Search already caches successful exact queries. Add source-version reuse/coalescing with identity-safe extraction keys; distinguish cold and warm runs. | Duplicate fetch/model count and unchanged evidence support. |
| Relevant passage selection | HTML already uses Readability. Rank useful passages within long documents while retaining the original source and citation offsets; preserve an expansion path for omitted sections. | Bytes/tokens per recovered fact and missed facts outside selected passages. |
| Local structured organization lookup | ROR documents using its data dump/local API. Potentially remove repeated network resolution, with versioned refresh. | Cold installation/storage cost versus actual lookup latency saved. |
| Benchmark judge queue | `evaluateLivePopulation` waits for each person's judge before starting that worker's next research job. Separate bounded research and judge queues. | Research-slot idle time and full-arm duration; no change to per-person product latency. |

[Scrapy AutoThrottle](https://docs.scrapy.org/en/latest/topics/autothrottle.html)
adjusts per-slot delays from latency and does not let fast error responses increase
the request rate. [Trafilatura's extraction options](https://trafilatura.readthedocs.io/en/latest/usage-python.html)
make precision/recall tradeoffs explicit. [Crawl4AI's content filters](https://docs.crawl4ai.com/core/fit-markdown/)
provide examples of structural pruning and query-based passage scoring. These
are mechanisms to test; the current use of Readability means basic main-text
extraction is already present.

The benchmark queue behavior is visible in
[evaluateLivePopulation](https://github.com/nicolas-found42/chief-of-staff-demo/blob/59550c4/apps/server/src/person-benchmark/evaluate.ts).
On this run, later research jobs began as first-group judging finished, while
research capacity was otherwise idle. Faster judging improves the developer loop;
it does not speed up production research, which does not run the benchmark judge.

## Prioritized implementation and measurement plan

1. **Canonical source identity and exact extraction reuse.** First bounded ticket;
   use the actual Bing/Yahoo/Nasdaq aliases as reproduction fixtures, preserve
   attribution and content revisions, and verify fewer model calls.
2. **Provider-specific query construction and result types.** Start with the
   ORCID/ROR failure concentration. Add representative non-English and ambiguous
   identity cases; audit official-page false negatives.
3. **Bounded extraction pipeline.** Remove the batch barrier and sequential model
   bottleneck with correct durable in-flight state and lifecycle fencing.
4. **Coverage/novelty-driven expansion.** Establish the quality-versus-time curve,
   agree on completion evidence, and then change policy if justified.
5. **Separate benchmark research and judging.** Can be an independent developer
   throughput ticket, keeping comparison conditions explicit.

For each change, use deterministic replay first, then a small live cohort chosen
for aliases, source noise, long documents, sparse footprints and ambiguous names.
Only then run the full 30-person acceptance population. Keep corpus, provider,
model, judge, cache state and network conditions recorded. Compare supported
recovery, critical identity/integrity failures, completion rate, first useful
publication, total latency, request count and provider-reported cost. Distinguish
new-model effects from scheduler changes and warm-cache effects from cold runs.

A 3–5x reduction is an ambitious engineering target, not established by the
research. No single source supports that gain here, and individual gains cannot
be multiplied: duplicate removal, better queries and concurrency overlap in what
they save. The current evidence supports specific experiments, not a promised
completion time.

Do not begin with a new crawler framework, a wholesale model sweep, higher global
concurrency, shorter timeouts, or a host/industry exclusion list. The first
optimizations can be tested in the existing composition and preserve the
anonymous-source and continuous-operation contracts.

## Research provenance and limits

Context Awesome discovery returned ACHE and Trafilatura among crawler/extraction
resources. These catalogue entries were leads only; the claims above cite their
owners. gh_grep inspected Crawl4AI, Scrapy, Crawlee, p-map and Searx code. Firecrawl
retrieved their documentation, ORCID/ROR documentation and primary research
abstracts. Some Firecrawl pages were cache hits; this note does not claim live
endpoint eligibility from documentation retrieval. No subagents were used.

No production change, new paid acquisition dependency, model sweep or additional
live acceptance arm was introduced by this research. The first-four trace census
is reproducible from the named run records, but is not representative evidence
for all industries. Near-duplicate and bandit proposals are research candidates;
they need local experiments before adoption. The ongoing #239 result must be
reported independently, including failure or incomplete execution.
