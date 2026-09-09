# Person benchmark: collection-scenario assessment and frozen acceptance corpus (#243)

Authored 2026-09-06 for issue #243 (child of #228). Gives the collection-level
scenario its real-model assessment, then freezes one corpus version by its
content identity as the reference for both acceptance arms.

Frozen corpus version: `14bca86ee0b97d28` — 30 people, 277 reference facts,
1 collection scenario, zero rejected. The version is the sha256-derived content
identity `loadCorpus` computes over `{ people, scenarios }`
(`apps/server/src/person-benchmark/corpus.ts`), so any reference-content change
moves the version even when an author's version label stays the same. Both
acceptance arms must cite this version; a comparison is only attributable if
both arms saw these exact references.

## Collection scenario assessed against real research output

Scenario `directing-and-screenwriting` (categories `directing` +
`screenwriting`; expects `bong-joon-ho` via facts `debut` and
`shared-screenplay`) is carried by requirement r18, which no individual
biographical fact can express. The scenario definition in
`benchmark/person-research/collection-scenarios.json` is unchanged since commit
`be96259`, and neither expected fact (`debut`: r7+r16; `shared-screenplay`:
r1+r4+r16) was altered by the #240–#242 fact authoring (additions only; zero
changed lines touching either fact between `be96259` and the frozen tree), so
the retained live runs below exercised exactly the frozen expectation.

Verdict from real research output: **assessed, expected person missing, both
arms**. Assessment status is `completed` (not failed) in both retained
reassessment reports, which completed all 30 per-person assessments plus the
collection scenario under judge `.7`:

- Fixed arm
  `current-fixed-judge7-recovery1-2026-09-06/fixed-documents-expanded-reassessed-bbc8e62af386b229.json`:
  `expectedMatches ["bong-joon-ho"]`, `demonstrated []`, `recoveredMatches []`,
  `missingMatches ["bong-joon-ho"]`, `assessments []`. Denominator honored with
  a sparse population: `activeProfiles 30`, `researchedProfiles 2`. Cause in
  the retained evidence: Bong's fixed-documents operation concluded
  `interrupted` (`model-boundary-failed` during extraction) with
  `claimsPublished 0`, so the collection query had no demonstrated
  directing+screenwriting intersection to judge.
- Incumbent arm
  `current-incumbent-judge7-recovery1-2026-09-06/live-discovery-incumbent-reassessed-f93fe67376b87cec.json`:
  same missing verdict, `demonstrated []`, `assessments []`;
  `activeProfiles 30`, `researchedProfiles 11`. Bong's live-discovery operation
  concluded `bounded` with `claimsPublished 0` (all dossier sections `planned`,
  discovery collectors `investigated`), the same empty demonstrated set through
  a different research path.

No live model spend was needed for this assessment: the retained runs already
exercise the scenario end to end (sparse denominators 2/30 and 11/30,
full 30-profile denominator check inside `evaluateCollection`, empty
demonstrated set → missing rather than failure). A fresh live run would
re-measure research quality, not the scenario mechanics, and is left to the
acceptance arms running against the frozen corpus above.

## Frozen corpus loads with everything validated

```
bun -e 'import { loadCorpus } from "./apps/server/src/person-benchmark/corpus.ts";
  const c = loadCorpus("benchmark/person-research/people");
  console.log(c.people.length, c.rejected)'
→ 30 []
```

`pnpm exec tsx scripts/person-research-benchmark.mts --corpus-coverage` prints
the same corpus `14bca86ee0b97d28` with 30 people, per-requirement counts
below, `Collection scenarios: 1 (r18; separate from individual facts)`, and
zero REJECTED lines. Loading validates every document hash, every reference
quote against its retained excerpt, and every scenario expectation against a
known person and fact; failures land in `rejected`, never silently skipped.
Duplicate document IDs are rejected by `validateReference` (fault-probe:
`rejects ambiguous document identities instead of silently choosing one
retained version` in `tests/src/modules/person-benchmark.test.ts`); duplicate
person slugs across files reject the later copy while keeping the first
(fault-probe added here: `rejects duplicate person slugs instead of silently
evaluating one copy` in `tests/src/modules/person-benchmark-collection.test.ts`).

## Individual-fact coverage across the twenty dossier requirements

Counts are individual reference facts (`requirementCoverage`); r18 has zero
because a capability intersection with a denominator cannot be stated by one
fact — it is carried solely by the collection scenario (1 scenario, above).
The scenario's two expected facts contribute to r1, r4, r7 and r16 as ordinary
individual facts; the intersection itself is assessed only through the
collection query.

| Requirement | Facts | People | Carried by |
|---|---|---|---|
| r1 Personal contribution distinguished from team output | 42 | 24 | individual facts |
| r2 Sourced operating magnitudes with unit, scope and date | 26 | 18 | individual facts |
| r3 Claimed and demonstrated expertise in one taxonomy | 22 | 14 | individual facts |
| r4 Counterparties, relation type, shared work and dates | 25 | 21 | individual facts |
| r5 Documented constraint environments | 10 | 8 | individual facts |
| r6 Work followed after departure | 3 | 3 | individual facts |
| r7 Dated history of problem areas and focus | 128 | 30 | individual facts |
| r8 Writing and thinking separated from building | 30 | 20 | individual facts |
| r9 Independent verifiers and the exact assertion verified | 28 | 18 | individual facts |
| r10 Per-section freshness and explicit gaps | 10 | 10 | individual facts |
| r11 Deciding, recommending and executing distinguished | 77 | 23 | individual facts |
| r12 Unsuccessful work and postmortems | 10 | 7 | individual facts |
| r13 Repeated collaboration evidenced by distinct shared work | 7 | 7 | individual facts |
| r14 Third-party credit and acknowledgments | 21 | 15 | individual facts |
| r15 Dated governance, funding and advisory ties | 25 | 13 | individual facts |
| r16 Dated observed artifacts by kind | 39 | 18 | individual facts |
| r17 Individually dated domain crossings | 44 | 24 | individual facts |
| r18 Capability intersections reported with denominators | 0 | 0 | **collection scenario only** |
| r19 Documented availability constraints | 7 | 6 | individual facts |
| r20 Source composition and single-source dependency | 19 | 16 | individual facts |

Total: 277 facts across 30 people plus 1 collection scenario. Every requirement
is covered: r1–r17, r19 and r20 by individual facts; r18 by the
`directing-and-screenwriting` scenario assessed above.

## Verification

- `pnpm --filter @chief-of-staff-demo/tests exec vitest run
  tests/src/modules/person-benchmark-collection.test.ts`: 4 tests green
  (supported intersection with sparse coverage; real-scenario immutability;
  unknown-support rejection with version change; new duplicate-slug probe).
- `pnpm run check`: green before the pull request (recorded in the PR body).
