# Spoken-evidence reference facts for eight Benchmark People (issue #240)

Date: 2026-09-06. Corpus version after these additions (incl. review fixes): `962a0a75a5e117fc`
(`pnpm exec tsx scripts/person-research-benchmark.mts --corpus-coverage` prints
zero REJECTED lines). All eight assigned people gained dated spoken-evidence
facts, so the corpus carries no left-honest entries for this batch: each of the
eight has a genuine, verbatim public spoken record that was fetched and inspected.

## What was added (spoken-evidence documents + two facts per person; Mottley carries two bounded excerpts)

| Person | Document (family `spoken-evidence`) | Source + date | Facts |
|---|---|---|---|
| Sally Kornbluth | `inaugural-address-2023` — official transcript of the inaugural address | MIT Office of the President, delivered 1 May 2023 | `bench-scientist-roots` (career, r3+r7, core): her own start as a "pipette-and-centrifuge, buckets-and-buckets-of-frog-eggs" cancer biologist with a ~12-person lab; `leaders-good-for` (ideas, r11+r7, supporting): "What are university leaders good for?" answered from her move into administration (review-trimmed to stay inside the retained support) |
| Mia Mottley | `cop26-three-gaps` + `cop26-code-red` — two bounded quotation excerpts from the COP26 World Leaders Summit opening address | Black Agenda Report transcript page (published 3 Nov 2021) of the address delivered 1 Nov 2021 | `three-gaps` (ideas, r2+r7, core): mitigation 2.7°C pathway, $20bn short of $100bn, adaptation at 25% vs 50/50, SIDS finance −25% in 2019; `code-red-1-5` (ideas, r5+r7, core): code red to the G7/G20, 1.5°C to survive vs 2°C as "a death sentence" |
| Tedros Adhanom Ghebreyesus | `who-briefing-2020-03-11` — opening remarks at the COVID-19 media briefing | WHO, 11 Mar 2020 | `pandemic-characterization` (overview, r2+r11, core): 118,000 cases / 114 countries / 4,291 dead and the pandemic assessment; `first-controllable-pandemic` (overview, r7+r11, supporting): first coronavirus pandemic, first that could still be controlled |
| Kristalina Georgieva | `atlantic-council-2020-04-27` — video-event transcript of the Front Page conversation | Atlantic Council, 27 Apr 2020 | `crisis-motto` (work, r3+r11, core): five years as crisis commissioner, "pray for the best, prepare for the worst, and act decisively"; `lockdown-outlook-reversal` (work, r2+r7, supporting): 160 countries with positive per-capita growth three months earlier vs the sudden reversal |
| Mary Barra | `house-testimony-2014-04-01` — sworn testimony in the ignition-switch hearing | U.S. GPO (CHRG-113hhrg89888), 1 Apr 2014 | `recall-apology` (work, r11+r12, core): "Today's GM will do the right thing", apology, Valukas investigation; `on-my-watch` (work, r1+r12, supporting): personal responsibility, pledge of transparency |
| Jane Fraser | `house-testimony-2021-05-27` — testimony as Citi CEO | U.S. GPO (CHRG-117hhrg45252), 27 May 2021 | `first-day-agenda` (work, r2+r7, core): $1bn racial-wealth-gap effort, $200m programme announced that morning, net zero by 2050 announced on her first day as CEO (review-trimmed: no "first testimony" claim — not in the retained excerpt); `scotland-to-citi-ceo` (career, r7+r17, supporting): Scottish village, U.S. 1987, citizen 2001, CEO March 2021 |
| Devi Shetty | `fixing-healthcare-ep7` — transcript PDF of the podcast interview (Season Two, Episode 7) | Fixing Healthcare podcast, 11 Feb 2019 | `price-tag-on-life` (work, r2+r5, core): the $800 open-heart operation as a price tag on a child's life — this documents the affordability constraint, so the stale r5 `unavailable` entry was removed; `simplicity-before-cost` (ideas, r3+r7, supporting): the keystone habit, make care simple and costs fall (review-trimmed: no O'Neill attribution — not in the retained excerpt) |
| Soumya Swaminathan | `science-in-5-ep1` — full transcript of Episode #1, Herd immunity | WHO, 28 Aug 2020 | `herd-immunity-explainer` (expertise, r2+r3, core): measles 95% threshold, barrier breaking transmission; `vaccines-not-wild-infection` (expertise, r3+r7, supporting): against natural-infection herd immunity, for vaccine-context herd immunity |

## Method and honesty notes

- Every excerpt is a contiguous slice of the page/PDF text actually fetched on
  2026-09-06 between 23:15 and 23:17 UTC (see each document's `retrievedAt`;
  fetch order: MIT, WHO Tedros, WHO Science-in-5, GPO Barra, GPO Fraser,
  Fixing Healthcare PDF, Atlantic Council, BAR Mottley). Every support quote
  was sliced programmatically out of the fetched text, never hand-transcribed;
  SHA-256 hashes are computed over the exact stored excerpt strings.
- `publishedAt` is the source's own date where stated (event/delivery date for
  speeches and testimony; page date 2021-11-03 for the Mottley transcript page,
  whose transcript is of the 1 Nov 2021 address; episode-page date 2019-02-11
  for the Shetty transcript, corroborated by the PDF creation metadata).
- The Mottley retention is two bounded quotation excerpts (773 and 788 chars:
  the three-gaps passage and the "code red" closing passage), excluding the host
  page's editorial framing and the rest of the address.
- Acquisition is `app-supported` for the seven plain-HTML pages fetchable with
  an anonymous GET (MIT, WHO ×2, GPO ×2, Atlantic Council, BAR). The two
  Shetty facts are `beyond-current-coverage` with a note: they are retained
  from a podcast transcript PDF, and audio/PDF-transcript ingestion is beyond
  what the application's anonymous text-HTML collectors cover today. That is
  recorded as a target, not silently dropped.
- IMF institutional pages answer anonymous collection with access-denied (see
  the pre-existing `imf-own-bio` coverage note in kristalina-georgieva.json),
  so the Georgieva spoken record comes from the Atlantic Council's transcript
  instead — verified fetchable anonymously.
- Nothing existing was removed or weakened, except where review demanded
  consistency: each file gains documents/facts plus a `referenceVersion` bump
  and `corrections[]` entries. `git diff` shows deletions only of bumped version
  strings, previously empty `corrections` arrays, the two review-trimmed
  statement clauses, the superseded full-address Mottley excerpt, and the stale
  r5 `unavailable` entry that the new spoken fact now covers. Requirement
  coverage did not regress (r18 remains covered by its collection scenario, as
  before; r5 coverage on devi-shetty is new, not weakened).

## Verification

- `pnpm exec tsx scripts/person-research-benchmark.mts --corpus-coverage`:
  corpus `962a0a75a5e117fc`, 30 people, zero REJECTED lines.
- `pnpm --filter @chief-of-staff-demo/tests exec vitest run
  tests/src/modules/person-benchmark-collection.test.ts
  tests/src/modules/person-benchmark.test.ts`: 2 files, 17 tests, all pass.
  (Note: the issue text names `tests/src/unit/person-benchmark.test.ts`; the
  file actually lives under `tests/src/modules/`.)
- `pnpm run check` green before the PR (see PR body).

## Review fixes (post-review, same day)

- `mia-mottley.json`: the `cop26-world-leaders-summit` document rights relabeled
  `short-quotation` → `public-record`, because the retained excerpt is the full
  body of the official 1 November 2021 head-of-government statement at the
  COP26 World Leaders Summit opening (a UN proceeding) — a public governmental
  record, consistent with how the corpus labels GPO hearing transcripts and
  other official transcripts. Bounding was rejected as dishonest: the facts'
  support quotes span the whole address, so a "quotation-style slice" would
  still be the whole speech. Note text updated with the justification. Excerpt
  and hashes unchanged.
- `sally-kornbluth.json`: `corrections[]` prose fixed to the hyphenated fact id
  `bench-scientist-roots` (was `bench-scientist roots`), matching the sibling
  files' greppable form.
- Corpus version after these fixes: `a119e190db2bba7a` (was `93272064f8572de9`
  at PR creation). Re-validated: zero REJECTED lines, narrow gates green,
  `pnpm run check` green (see PR body).

## Review fixes, round 2 (CodeRabbit majors + doc minor, 2026-09-07)

- `devi-shetty.json`: the $800 `price-tag-on-life` passage documents the
  affordability constraint the hospital model operates under, so the stale r5
  `unavailable` entry ("No retained source documents the constraint
  environment…") was removed and r5 coverage stands on the new fact — real
  coverage, not a weakened expectation.
- `devi-shetty.json` + `jane-fraser.json`: statements trimmed to the four
  corners of the retained excerpts — no Paul O'Neill attribution (the retained
  slice starts at "the behavior called the keystone habit"), no "first
  congressional testimony" claim.
- `sally-kornbluth.json`: `leaders-good-for` trimmed of the MIT-community
  clause, which the retained excerpt does not establish; the remaining claim is
  fully supported by the two retained quotes.
- `mia-mottley.json`: the full-address document is replaced by two bounded
  quotation excerpts (`cop26-three-gaps`, 773 chars; `cop26-code-red`, 788
  chars), each carrying exactly the support quotes of its fact, rights
  `short-quotation`, hashes recomputed, support re-pointed, `referenceVersion`
  bumped to 2026-09-06.3 with a `corrections[]` entry. No other file's version
  changed.
- This doc: "nobody was left honest" reworded to "carries no left-honest
  entries for this batch" (the confusing double-negative CodeRabbit flagged).
- Corpus version after round 2: `962a0a75a5e117fc`. Re-validated: zero
  REJECTED lines, narrow gates green, `pnpm run check` green (see PR body).
