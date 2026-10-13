# Adversarial teardown: useful public research and evidence boundaries

The accepted retrieval defects are fixed and locally verified. The final
publication gate is the PR's five current-head CI checks and squash merge;
that result belongs to the delivery record. This report describes bounded
verification, not exhaustive certification of the app or public web.

## Target, authority and baseline

The user selected latest `main` in an isolated managed worktree after the
original checkout proved to be the older walking-skeleton branch. Target:
`nicolas-found42/chief-of-rust`, app 0.1.0, baseline
`3155bf2bd6023e0d16fa435733bdf76e29811a83`. The original checkout's five
unfinished port edits were preserved; observations about that prototype were
excluded from findings about the selected product. [Original diff](evidence/prototype-baseline.diff).

The selected checkout started clean. Rust/Cargo 1.98.1 on macOS arm64; Docker
Desktop 4.90.0 / Engine 29.7.2, Linux arm64 container; browser automation with
isolated context, native HTML forms and script-disabled CSP. Existing source,
README, agent guidance, issue #11 and the previous UX report define five
product areas, SQLite records, exact dossier quotations, reviewed content and
bounded provider work. The previous report is historical evidence, not proof
of this run. [Baseline](evidence/baseline.json),
[tests](evidence/baseline-tests.log), [image](evidence/baseline-image.log),
[boot](evidence/baseline-boot.log).

Authority: the user permits local research and improvements. Repository
`docs/agents/pr-workflow.md` additionally preauthorizes branch, commit, PR and
squash merge after five green checks bound to the head SHA. No production
Workspace, account grants, mail, Tasks delivery or external publication was
modified. Test data is fictional and disposable. Only the task-owned Compose
project `chief-adversarial-main` uses port 55317 and its own named volume.

Skills: adversarial-ux-test 2.0.0 (SHA-256
`c790dcbd617e5481e50fd5aeb432526ef976c14db011b2631ea3f4f73697f157`),
Jev (`0a5acb5d5e2c4681e8fcf908fece465ef47c703feee0d3827e101c3aaee8fa40`),
jgrep, code-review, Conventional Branch/Commits, PR and cleanup guidance.
Jev provider/model: OpenRouter `typesafe/jev-1.13-20260917`. Judgments used
bounded source/diff/log excerpts, with no installation keys or token caches.
Credential availability was recorded as booleans only. Child HTTP tests use
`env_clear()` and explicit fixture endpoints, with no inherited HOME, sessions
or credentials. Existing live Mistral access was available; other account
integrations remained unconnected.

The original 45-minute prototype budget expanded to 90 minutes when the user
selected the 11,600-line product. About 40 minutes elapsed through local
verification from 09:50 EDT; reporting, final judgment and CI follow that
phase. Their timestamps and outcomes are in the final gate and PR. No claim
that automation duration measures human effort.

## Persona and stable acceptance criteria

Inferred persona: technical Found42 operator gathering evidence, preparing
work and checking saved outputs. Uses README, product links and normal forms;
knows Docker, distrusts repeated sources and unexplained limits, and stops
unchanged retries. This is simulated usability, not participant evidence or
a claim about preferences/adoption. Source-assisted diagnosis and HTTP fixture
tests are explicitly separate from the unaided browser Task/research flow.

| Requirement | Observable acceptance criterion |
| --- | --- |
| R1 / first use | Isolated Docker boots; all five areas, Settings, Runs and health respond; native form creates usable saved work; restart preserves it. |
| R2 / useful coverage | Select eight distinct nonempty source URLs when at least eight exist in the returned response. Invalid/empty/duplicate rows must not consume slots. |
| R3 / evidence admission | No completed source-backed watch/project report from an empty overall evidence collection. HTTP and malformed responses remain failed Runs. |
| R4 / provenance and gaps | Watch reports, project research and dossiers persist and render first-page/snippet limits, exclusions, omitted unique results, truncation and unavailable engines. |
| R5 / compatibility | Legacy records deserialize; history, exact quotes, stale-input fences and review gates remain intact; required checks pass. |
| R6 / optional search | A Person's nonempty saved evidence remains usable when optional successful search yields no snippets. No silent fallback on HTTP/shape failures. |
| R7 / public transport | An ambient proxy cannot replace the DNS-checked, pinned destination used by direct public fetching. |

R6 made an existing preservation requirement explicit after the stronger
review discovered an introduced regression; it does not redefine an empty
*overall* collection. The red result and original change are retained.

## Findings and critique of the critique

| Finding | Type / impact / evidence | Disposition |
| --- | --- | --- |
| F1: duplicates and premature capping waste useful coverage | Demonstrated coverage defect under fixture conditions; recoverable quality loss, no record loss; real HTTP/router/worker and saved records, E4. | Fixed and verified, D1 / E6. |
| F2: blank snippets permit a completed report without source text | Confirmed evidence-admission defect in fixture path; misleading success, no claim of live model hallucination; E4. | Fixed and verified at consumer boundary, E6. |
| F3: saved research omits collection limitations | Demonstrated review friction / justified capability improvement; original pages/exhaustiveness never promised; E3/E6 and live E10. | Fixed and verified for all three search consumers. |
| F4: configured proxy bypasses pinned public connection | Conditional transport reliability/security defect; default Docker exploit and private-service access not demonstrated; E5. | Direct public fetch disables proxies; fixture receives zero requests, E6. |
| F5: initial patch rejects a dossier despite saved manual evidence | Introduced P2 regression caught by stronger Spec review; optional empty search was confused with empty combined evidence; E7. | Fixed before publication; both zero-result and blank-snippet holdouts pass, E6. |

F1 reproduction: the controlled response has 26 rows: twelve fragment
variants of A, three invalid URLs, two empty snippets and nine other useful
URLs. Existing `take(12)` and downstream `take(8)` saved eight variants of A.
Counterevidence: real SearXNG often consolidates duplicates, and the fixture
does not estimate incident frequency. The discriminating probe is a valid
response with these variants and a later useful source. One unique document
was observed before, eight afterward. No arbitrary query-parameter stripping
was added; those parameters may identify different documents.

F2 reproduction: two HTTP results have empty/whitespace `content`. The
pre-fix worker marks `done` and saves one report with blank Evidence texts.
A contract-valid model fixture isolates evidence admission; it does not
establish what a live model would say. The rejection criterion is that a
source-backed collection needs source text. A nearby nonempty case succeeds;
manual evidence plus empty optional search also succeeds after F5 correction.

F3 basis: an operator must inspect the support and gaps in generated research.
Before, code capped/truncated snippets and discarded failed-engine metadata.
The implementation never retrieved original pages on this path, so claiming
false full-page retrieval as a universal product defect was rejected. The
fix displays deterministic collection facts independently of model prose.
Earlier records show absent coverage rather than invented historical counts.

F4 reproduction: a credential-cleared child sets HTTP_PROXY/http_proxy to a
local Wiremock server, then calls the real public fetcher for a public IPv4
literal. DNS is pinned, yet the proxy receives the request and supplies its
fixture bytes. After `.no_proxy()`, it receives zero requests. The direct
attempt is cancelled after two seconds; this test does not prove successful
direct fetching or exhaustive SSRF protection. Reqwest's own proxy docs and
source explain the competing transport. Default Compose does not supply this
proxy configuration, limiting demonstrated impact.

F5's strongest counterargument was that no report should be generated after
an empty search. That applies to an empty combined collection; People has
existing evidence and advertises optional public search. A new HTTP holdout
failed at `bf48082`, then passed at `7112f63`, reading the retained manual
source, exact quote and selected-zero coverage. HTTP failures still propagate.

Simulated reaction: “Eight sources looked reassuring until I saw the same
document repeated. I need to see what was actually collected and what is
missing.” This generates a review hypothesis; the fixtures and saved records
establish the observed defects.

## Experiments, decisions and measured tradeoffs

| Experiment / decision | Control, observation and result |
| --- | --- |
| X1 / D1: normalize existing first-page collection | Same 26-row HTTP corpus and eight-source bound. Before: one unique document; after: eight, no empty evidence. Chosen over documentation-only retention. |
| X2: empty/invalid collections | Empty watch fails with zero reports; HTTP 503, wrong result-list shape and invalid JSON fail without leaking the provider body. Query-bearing URLs stay distinct; blank first duplicate cannot mask a later useful snippet. |
| X3 / D2: preserve collection facts | All three product paths read real stored records; watch record survives database reopen; dossier quote is an exact original snippet. Model output remains a fixture in corpus tests. |
| X4 / D3: direct public connection | Before: local proxy receives one request and returns source bytes; after: zero requests, bounded cancellation of direct control. |
| X5 / D4: optional search holdout | Initial patch failed manual-evidence dossier. After correction, empty array and blank snippet produce a dossier with one saved manual source and coverage selected=0. |
| X6: live/packaging re-attack | Docker rebuild, boot, native Task edit, restart persistence, two live Mistral acceptance tests, and a live search/report. E9/E10. |

Reference set for X1 is ten unique useful documents deliberately defined by
the corpus. Unique-document completeness increases 1/10 (10%) to 8/10 (80%),
the ceiling of the retained cap. Selected source-row precision is 8/8 usable
and fixture-relevant before and after; duplicates are a separate completeness
failure. These are corpus measurements, not natural-web relevance, factual
accuracy or exhaustive retrieval metrics.

Collected context increases from 160 repeated characters to 6116 useful
characters (including a 6000-character Unicode snippet); selection still uses
one search HTTP request, at most eight snippets, 6000 characters each, the
existing 4 MB response bound and 45-second timeout. This is a useful-coverage
tradeoff, not a measured latency improvement. Timing differences between tiny
fixtures were not treated as a benchmark.

The live query for SQLite public documentation returned 20 rows: eight saved
snippets, twelve unique results omitted, and brave/duckduckgo/startpage
unavailable. The report names `mistral-large-4` and its actual gaps. Source
dates/current truth and every generated conclusion were not independently
verified. [Desktop coverage](evidence/live-coverage.png),
[metadata](evidence/live-metadata.json). A 390-pixel viewport had page width
390 and notice width 358; inspected notice text wraps without horizontal
overflow. This is a targeted viewport check, not a screen-reader or broad
accessibility certification.

## Research and addition eligibility

| Candidate | Mechanism, eligibility and disposition |
| --- | --- |
| Retain behavior with docs | No dependencies/calls added; cheapest, but X1/X2 failures remain. Rejected by D1. |
| Internal normalization and coverage | Existing url/serde_json/reqwest only. Runs against anonymous local HTTP fixtures with cleared environment; no account, key, software/service charges or installation addition. Implemented. Cargo manifests/lockfile and container dependencies unchanged. |
| Bounded extra SearXNG pages | Existing API supports `pageno`; additional pages might broaden unique coverage but also duplicate results and add latency. No same-workload benefit measured, so kept out. Evidence needed: anonymous multi-page controls, dedup/gap handling and measured useful coverage. |
| Fetch originals or add browser/extractor service | Might improve completeness/format support; extra failure, resource and eligibility questions remain. No new integration or execution dependency added. Learning from the option does not approve it. |

Primary research, retrieved 2026-10-13:
[SearXNG API](https://docs.searxng.org/dev/search_api.html) documents the page
parameter and enabled JSON formats;
[reqwest 0.13 client builder](https://docs.rs/reqwest/0.13.5/reqwest/struct.ClientBuilder.html)
and [source](https://docs.rs/reqwest/0.13.5/src/reqwest/lib.rs.html) document
system proxies and `.no_proxy()`;
[scraper 0.24](https://docs.rs/scraper/0.24.0/scraper/) remains the existing
static parser. OWASP CSRF guidance and htmx/Google pagination sources informed
the superseded prototype reconnaissance; they did not justify changing the
selected app's already-tested local form boundary. No source-category quota,
popularity inference or untrusted recommended command was used.

Existing Mistral, Google and optional provider services remain baseline
credentialed constraints, not newly eligible additions. Jev/jgrep and browser
tools are investigation tools, not app dependencies. No purchase or new
account/access was required. No shipped-binary-only question arose, so REA
was not applicable; the selected source was complete.

## Coverage map and evidence ledger

| Workflow / risk | Coverage | Requirement / evidence |
| --- | --- | --- |
| Installation, five pages, local Task, restart | Tested: Docker smoke plus native browser create/edit and reread | R1 / E0/E9/E10 |
| Search normalization and bounded evidence | Tested: known real HTTP corpus, negative and holdout cases | R2/R3 / E4/E6/E7 |
| Watch/project/dossier record/UI lineage | Tested: router/worker, actual records, reopen, legacy JSON, exact quote | R4/R5/R6 / E6 |
| Model-dependent core workflows | Tested: two live Mistral tests; local fixtures separately | R5 / E8/E9 |
| Real public watch/report | Tested once through native browser, SearXNG and Mistral | R4 / E10 |
| Duplicate/stale/privacy/schedule/account fencing | Tested by current ordinary suite; not repeated as live account actions | R5 / E8 |
| Proxy transport, malformed responses, secret-safe errors | Tested under specified fixture configuration | R3/R7 / E5/E6 |
| Desktop/mobile coverage notice | Tested at 1280×720 and 390×844; AX text supplements pixels | R4 / E10 |
| Full web relevance/accuracy, pagination/original-page completeness | Partially tested through corpus and one live query; broader completeness untested | Explicit first-page/snippet gap |
| Google/Asana/HubSpot/YouTube live accounts | Unverified: credentials unavailable; fixture tests pass | No connection success claim |
| All nine formats, all UI branches, screen readers, Windows/x86 | Untested live in this run; some ordinary coverage | Nonessential breadth limits |
| Direct Scout source formats/redirects/encoding fidelity | Partially inspected; proxy path tested, no broad format/quality claim | Static parser/40k→16k source limits remain an explicit unmeasured opportunity |

| Evidence | Durable record / witness |
| --- | --- |
| E0 | [baseline.json](evidence/baseline.json), baseline image/boot/test logs |
| E1 | README, source, issue #11 and prior UX report; scoped as commitments/history |
| E2 | [retrieval-locations.json](evidence/retrieval-locations.json): jgrep locations, not correctness proof |
| E3 | source diffs and primary references above |
| E4 | [retrieval-before-expanded.log](evidence/retrieval-before-expanded.log): duplicate and empty-record red reproductions |
| E5 | [proxy-before.log](evidence/proxy-before.log), expanded red log with received-request witness |
| E6 | [retrieval-final.log](evidence/retrieval-final.log), [holdouts](evidence/search-holdout-final.log), public_research.rs and current suite |
| E7 | [manual-regression-before.log](evidence/manual-regression-before.log), preserved first-patch failure |
| E8 | [fmt](evidence/fmt.log), [check](evidence/check.log), [clippy](evidence/clippy.log), [tests](evidence/tests.log) |
| E9 | [live-mistral.log](evidence/live-mistral.log), [final image](evidence/final-image.log), [boot](evidence/final-boot.log), [smoke](evidence/smoke.log), [final persistence](evidence/final-persistence.log) |
| E10 | [Task snapshot](evidence/browser-task.txt), desktop/mobile coverage images and metadata; fictional local browser records retained in task volume |
| E11 | [Jev investigation](evidence/jev-investigation.json), [Standards](evidence/standards-review.md), [Spec](evidence/spec-review.md), final gate recorded separately |

## Judgment resolutions and final checks

Jev screening `review` signals on issue/spec material were inspected for tool
redirection, credential requests and authority overrides. Declarative product
requirements were retained as evidence only; no concrete unresolved attack or
`block` signal occurred. Routing judgments are advisory, and arithmetic,
statuses, URLs and file existence were checked deterministically.

Jev's initial verification conflated a failed regression-test assertion with
the product's completed empty report. Expanded saved-record logs corrected
that boundary: support 0.94/confidence 0.91. Proxy evidence was likewise
narrowed; corrected verification support 0.93/confidence 0.89. The rejected
claim that normal Docker has a proven remote exploit is retained as a
negative control. Type/impact classifications had review outcomes; the host
resolved them by explicit source-contract, recoverability and conditional
configuration rules instead of inflating severity.

D1 selected internal improvement at 0.99, with no contradicted requirements.
The first patch review escalated test-gap confidence 0.31 and safe-to-apply
0.51. Separate stronger Standards/Spec reviews found F5, which was reproduced
and fixed. The Spec followup still had uncertain Jev signals (confidence
0.56/0.31); direct source/record/holdout review resolved those concerns, and
the unfavorable results remain recorded. Model agreement is not additional
runtime corroboration. The final gate uses the actual final diff and current
logs; its full distribution/action is retained beside the delivery record.

Exact final local gates:

```sh
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo test -p chief-of-rust --test live_mistral --locked -- --ignored
docker compose -p chief-adversarial-main -f docker-compose.yml \
  -f /tmp/chief-adversarial-live-override.yaml build app
docker compose -p chief-adversarial-main -f docker-compose.yml \
  -f /tmp/chief-adversarial-live-override.yaml up -d --wait app
python3 scripts/smoke.py http://127.0.0.1:55317 --verify-persistence
```

The task override publishes only 127.0.0.1:55317, uses the named task volume,
and either explicitly selects mock with blank connection keys or references
the existing Mistral environment key for live acceptance. No secrets are in
the override, logs or report. The final source checks pass: 72 ordinary tests,
zero failures, two live tests ignored by the ordinary suite; both live tests
pass separately. Image/boot and restart persistence pass. No manifests,
lockfile, Docker dependencies, migrations or production preferences changed.

Resources: task containers are stopped after inspection; only their own
volume/evidence are retained. The managed worktree remains attached for
review. Scratch evidence created in the original prototype checkout is moved
to quarantine, with the original five port edits compared byte-for-byte to
their initial snapshot. The original app containers and Workspace are left
untouched. Broad untested coverage above is nonessential to these accepted
fixes; there is no claim of perfection or exhaustive testing.
