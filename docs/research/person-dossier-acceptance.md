# Person Profile dossiers — acceptance matrix, collection limits, and budget decisions

_Recorded 2026-09-05 for [issue #212](https://github.com/nicolas-found42/chief-of-staff-demo/issues/212).
Binding acceptance is [issue #204](https://github.com/nicolas-found42/chief-of-staff-demo/issues/204);
the durable decision is [ADR-0062](../adr/0062-person-profiles-are-automatically-researched-dossiers.md)._

## Follow-up implementation and evidence

The remaining-work pass adds durable finite checkpoints, cumulative elapsed allowances, a real
SIGKILL-during-extraction restart regression, URL-bound pending documents, lifecycle fencing,
retained failed extractions, explicit extraction coverage, supported temporal supersession and
stable Work Record identity. Historical research refresh defaults to 720 hours; current research
uses 168 hours. Upcoming-meeting refresh can bypass cooldown after 24 hours, viewed Profiles after
48 hours, and material evidence or explicit requests can refresh sooner. In-flight work coalesces;
daily rollover preserves its original scope and consumption. A completed historical pass alone
advances historical freshness. Defaults remain bounded operation/time allowances, not monetary caps.

The refreshed two-person public canary in `person-dossier-canary.json` records per-URL diagnostics.
Simon Willison: one model call returned non-JSON, zero extracted claims/work, incomplete after eight
operations (about 17.2 seconds). Rich Hickey: the known page was blocked and other discovered pages
lacked established identity support, zero model calls/claims/work, incomplete after eight operations
(about 11.0 seconds). Useful matched retrieved text is now retained despite extraction failure.
Actual token usage and cost are unavailable from the configured completion interface. These results
show operational limitations, not successful dossier quality; the twenty-row hermetic coverage
matrix remains separate evidence. No provider email or remote Task was created by this canary.

The issue-by-issue follow-up, final gates and recovery instructions live in
[the remaining-work ledger](remaining-work-2026-09-05/progress.md). Earlier results below are historical
and must not be mistaken for proof of the later diff.

## What this document is

Issue #204 states twenty coverage requirements and one rule over all of them: _"Every requirement
must support real data when found AND an honest unavailable/uncertain state. A schema with fields
but no producer, storage, source links, or consumer is not completion."_

This is the review of that. The matrix below is not prose — each row is executed by
[`tests/src/modules/person-dossier-acceptance.test.ts`](../../tests/src/modules/person-dossier-acceptance.test.ts),
which asserts every requirement twice: once against a corpus that documents it, and once against a
corpus that does not. The missing half is the load-bearing one. A requirement passes only when the
dossier can also say, without inventing a value, that it does not know.

Three corpora carry the matrix:

| Corpus | Fixture | Role |
| --- | --- | --- |
| Populated | [`comprehensive.json`](../../tests/fixtures/person-dossiers/comprehensive.json) | One independent account documenting all twenty dimensions for a fictional person. |
| Missing | [`sparse.json`](../../tests/fixtures/person-dossiers/sparse.json) | A bare contributor listing: one supported claim, twenty explicit `unknown` claims, no fabricated values. |
| Conflicting | inline, same test file | Two independent registries recording contradictory current roles with no effective date. |

All fixtures are entirely fictional and carry that disclosure in the file. No row refers to a real
person, organisation, or deployment.

## The matrix

Each row names the assertion that runs. "Missing" is the state produced by the sparse corpus.

| # | Requirement (#204) | Populated | Missing |
| --- | --- | --- | --- |
| 1 | Personal contribution vs. team output | `contribution` and `teamContribution` hold distinct grounded text | both are `null`; the sparse corpus states the split is undocumented |
| 2 | Sourced operating magnitudes | scale entries carry value, unit, scope and a date | `scale` is empty — no magnitude is inferred from the listing |
| 3 | Claimed and demonstrated expertise in one taxonomy | one `demonstrated` and one `claimed` category, original wording retained | `expertise` is empty; neither kind is invented |
| 4 | Counterparties, relation type, shared work, dates | typed `co-authored` edge with a start date over two shared works | `connections` is empty |
| 5 | Documented constraint environments | the memory ceiling and audited release controls are retained | `constraints` is empty — no constraint is inferred from an industry |
| 6 | Work followed after departure | a dated `afterDeparture` outcome | no `afterDeparture` outcome exists |
| 7 | Dated history of problem areas and focus | dated career claims across 2021–2025 | work dates stay `null`; intervals remain unknown |
| 8 | Writing separated from building | the paper is `kind: "paper"` with no contribution; the system is `kind: "release"` | no paper, talk or post is recorded |
| 9 | Independent verifiers and the exact assertion | the verifying body and its report are named | no supported recognition claim exists |
| 10 | Per-section freshness and gaps | all eight sections carry gaps and none claims to be `current` | the section is `incomplete` with a stated gap |
| 11 | Deciding vs. recommending vs. executing | authority is `recommended` and `executed`, never `decided` | `authority` is empty; the title establishes nothing |
| 12 | Unsuccessful work and postmortems | a dated `unsuccessful` outcome | no `unsuccessful` outcome — recorded as a sourcing gap, not success |
| 13 | Repeated collaboration from distinct shared work | two distinct shared works for one counterparty | no collaboration is derived |
| 14 | Third-party credit and acknowledgments | the acknowledgment is retained with its solicitation left unknown | the gap is stated as an `unknown` claim |
| 15 | Dated governance, funding and advisory ties | the dated advisory seat and a `funded` edge | no governance-class edge exists |
| 16 | Dated observed artifacts by kind | two deduplicated periods by artifact kind, with the productivity caveat in scope | activity is empty — undated work is never plotted |
| 17 | Individually dated domain crossings | the dated academia-to-industry crossing | no supported career claim exists |
| 18 | Capability intersections with denominators | demonstrated 1, claimed 0, against 2 active and 1 researched Profile | demonstrated 0, claimed 0, denominators unchanged |
| 19 | Documented availability constraints | working language and timezone retained; restrictions explicitly undocumented | the query result reports both gaps to the reader |
| 20 | Source composition and single-source dependency | every claim is single-family; composition names one source class | 20 unknown claims; no claim gains a second family |

The conflicting corpus is asserted separately: two contradictory role facts become `contested`
rather than resolved, both accounts keep their own passage and source, the section summary is
prefixed `Contested account:`, the Profile's own factual record is **not** overwritten, and the
quality projection counts two contested claims.

Existing suites carry the lifecycle half of #212 and are not restated here:
[`person-dossier.test.ts`](../../tests/src/modules/person-dossier.test.ts) (restart, immutable
source versions, privacy deletion, detach, merge, mirrored-source families, exact revisions),
[`person-research.test.ts`](../../tests/src/modules/person-research.test.ts) (full-page retention,
Transcript evidence kept out of public projections),
[`person-research-queue.test.ts`](../../tests/src/modules/person-research-queue.test.ts)
(coalescing, restart resume, daily allowance, late results after archive),
[`person-automatic-entry.test.ts`](../../tests/src/modules/person-automatic-entry.test.ts)
(creation without web access, supersession of a manual correction, recreation prevention), and the
Playwright journey [`person-dossier-journey.spec.ts`](../../tests/e2e/person-dossier-journey.spec.ts).

## Collection methods actually supported

Retrieval is the shared keyless fan-out from
[ADR-0049](../adr/0049-public-search-fans-out-over-independent-keyless-providers.md), documented
provider by provider in [public-search-providers.md](public-search-providers.md). What the dossier
research loop does with it:

- **HTML pages** are parsed with Readability and retained as article text (up to 500 000
  characters), together with their outbound links, which is how the loop follows a person's own
  work without recursively researching every collaborator.
- **`text/*` responses** are retained verbatim.
- **PDF and DOCX documents** use byte retrieval and the existing local text converter.
  Parser failures remain explicit; this does not establish OCR support for scanned pages.
- **Feeds and public records** are rendered as quotable text; podcast transcript links become
  leads. Public Bluesky and Mastodon routes and a bounded anonymous browser fallback are
  implemented. Live endpoint access is recorded separately from grounded dossier quality in
  [person-source-eligibility.md](person-source-eligibility.md).
- **Video captions** are attempted when a public track is listed. Missing tracks and empty
  caption responses remain explicit gaps; descriptions do not count as spoken evidence.
- **Workspace Transcripts** enter as `visibility: "private"` sources only for identities the owner
  confirmed, and never reach a public projection.

Every retrieval outcome is retained on the source record (`retrieved` / `blocked` / `failed` /
`unsupported`) and surfaced per URL in the research job's diagnostics.

## Sources that remain unavailable

Recorded from the canary run in [`person-dossier-canary.json`](person-dossier-canary.json)
(2026-09-05) and prior provider research:

| Source | State | Evidence |
| --- | --- | --- |
| LinkedIn | No keyless read exists | [linkedin-reading-options.md](linkedin-reading-options.md) |
| DuckDuckGo, Mojeek, Marginalia, DBLP | Refused keyless traffic, then entered cooldown within one run | canary `diagnostics` |
| Openverse | Timed out at 60 s on both passes | canary `diagnostics` |
| GDELT | Answered once in 16.9 s, refused on the second pass | canary `diagnostics` |
| Arctic Shift, Wayback, IA TV News, EDGAR, GLEIF | Answered but empty for person queries | canary `diagnostics` |
| Bing News | Answered the first pass, empty on the second | canary `diagnostics` |
| Scanned PDFs and unsupported document formats | Text conversion is implemented for PDF/DOCX; OCR and additional formats remain unproven | `research-readers.ts` |
| JavaScript-rendered and paywalled pages | Optional bounded anonymous rendering can recover some pages; authentication/paywalls remain gaps | `research-readers.ts` |

Wikipedia, Wikidata, ORCID, OpenAlex, ROR, EuropePMC, GitHub users, Stack Exchange, Google News,
Reddit RSS, Wiby and Internet Archive answered on both canary passes.

## Historical budget decisions (2026-09-05)

Issue #228 replaces the daily-rollover model below with continuous research, parallel reading,
explicit completion conditions and separately reported safety bounds. The table is historical
canary context, not the current settings contract.

Measured, not assumed. Both canary profiles exhausted an 8-operation allowance before finishing:
72.4 s and 61.8 s wall clock, i.e. **7.7–9.1 s per research operation**, dominated by the search
fan-out's slowest members rather than by the model. The first profile spent one model call and
produced 4 claims and 2 work records across three sections, with **4 of 4 quoted passages
verified** against the retained document. The second produced no retained source and no model call
— an honest empty result, not a crash.

The shipped defaults in
[`research-queue.ts`](../../apps/server/src/person-profile/research-queue.ts) follow from that:

| Setting | Default | Why |
| --- | --- | --- |
| `concurrency` | 1 | The keyless providers share per-process cooldowns; the canary shows four of them refusing and cooling down inside a single pass. Parallel profiles multiply refusals rather than throughput. |
| `profileCalls` | 12 | 12 × ~9 s ≈ 108 s, which fits inside the per-profile time allowance with margin. |
| `profileMilliseconds` | 120 000 | Above the 72.4 s worst case observed, so the wall-clock limit is a backstop rather than the usual stop. |
| `dailyCalls` | 96 | Eight profiles per day at the full per-profile allowance. |
| `refreshHours` | 168 | Weekly re-research; explicit requests, imminent meetings and newly opened Profiles bypass the cooldown through queue priority. |

All five are Workspace settings, editable from the dossier panel and enforced before dispatch, not
after. Enforcement is covered by `person-research-queue.test.ts` (daily allowance exhaustion with a
deterministic clock, failed attempts counted, completed work preserved) and
`person-dossier-api.test.ts` (owner reads states and changes budgets without waiting on the web).

**Cost is not claimed.** `CompleteJson` does not return token usage, so the canary records
`actualTokens` and `estimatedCost` as explicitly unavailable and only reports the 6 388 input and
5 063 output characters it measured. No monetary cap is asserted anywhere in the product.

## Production proof

Recorded 2026-09-05 on this working tree:

| Gate | Result |
| --- | --- |
| `pnpm run check` | Pass — typecheck, lint, formatting, knip, 168 test files, 1 804 tests |
| `pnpm run check:all` | Pass — the above plus 76 Playwright tests |
| `docker compose build` | Pass |
| `docker compose up -d` → `GET /api/health` | `{"ok":true}`; brought down afterwards |

Failures that had to be fixed to get there, all drift left by the dossier work rather than by this
record:

- The Workspace migration boundary did not classify the six dossier directories or the research
  queue file, so `previewWorkspaceMigration` failed closed with `unsafe-mixed-state` on any
  Workspace that had researched anybody — and the repeatable generated-data clear, which shares
  that one table, would have left the dossiers standing. Both now classify them as disposable
  `person-profiles` state, and a regression test drives the real store so a seventh directory
  fails at the unit gate rather than in a browser journey.
- Returning from a historical revision to the current one collapsed the maintenance disclosure the
  reader had opened, which #209 forbids. The disclosure is now the reader's state; a historical
  revision raises it and returning no longer closes it.
- Nine source files were left unformatted and `person-research-queue.test.ts` never imported the
  `readFileSync` it calls, so `format:check` and the unit suite both failed. Two further type and
  lint errors in the new suites were being hidden by a stale `tests/tsconfig.tsbuildinfo`: an
  incremental typecheck reported success over files it had not re-read. Deleting the cache
  surfaced them. **The incremental cache can mask a real error in `typecheck:tests`; a gate run
  that has to be trusted should start from a cold one.**
- The same masking then repeated in `lint`, which is the reason this list has one more entry than
  the gate table above suggests. `scripts/lint-scopes.mjs` passes `--cache`, and the cache had no
  entry for the still-untracked `personProfilePrototypeData.ts`, so a whole-tree `pnpm run check`
  reported lint green over a file it never read. The pre-commit hook, which lints staged paths with
  no cache, caught a dead `?? []` on a `sourceIds` that `PersonDossierSchema` makes required.
  Removing `.eslintcache` and re-running took 57.7 s and was green across all seven scopes.
  **Both gate caches key on files they have seen; a new file can be absent from either. Cold-run
  `typecheck` and `lint` together before trusting a release gate.**
- A settings PATCH re-sent the whole settings object, so saving an unrelated research limit
  re-asserted `paused` and bumped the queue generation, cancelling in-flight research the edit
  never touched. The route and the panel now send only the settings the owner changed, and
  `person-dossier-api.test.ts` holds the narrowed patch to its live neighbours.
- `PersonProfileDetailPage` imported the throwaway `?variant=` prototype's stylesheet at module
  scope, so 16 kB of exploration CSS shipped in the production bundle and its selectors were live
  on every real Profile — against the switcher's own "never ship to prod" contract. The variants
  are lazy now and Vite splits them, with their stylesheet, into their own chunk.

Two efficiency defects were fixed alongside them, both on the Transcript-deletion path, which walks
every Profile: `PersonDossierStore.source` read and re-validated the whole dossier twice per call,
and `publish` re-read the rejection file once per citation. Neither changed behaviour.

No live Workspace data was reset and nothing was sent externally for this record.

## Known limitations of this record

- The retained canary predates the per-URL `diagnostics` field on the research outcome, so its
  JSON carries provider-level diagnostics but not per-URL retrieval and identity reasons. Those
  reasons are produced and stored on live research jobs; re-running the canary requires a
  configured provider key and live network and was not re-run for this record.
- The canary covers two public figures with a seeded profile URL and no employer hint. It is a
  provider-availability and passage-validity probe, not a quality benchmark.
- Neither figure's dossier reached `current` within its allowance; both stopped at `incomplete`
  with completed evidence retained, which is the designed behaviour and the reason broad backfill
  ships behind the queue's pause and priority controls.
