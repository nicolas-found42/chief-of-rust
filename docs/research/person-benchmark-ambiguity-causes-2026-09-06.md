# Why semantic verdicts land ambiguous — cause classification, 2026-09-06

Issue #234. All 133 ambiguous verdicts in the three retained reassessed
populations are assigned exactly one named cause below. The work repeats no
research, costs no discovery, and changes no input: it reads the retained
reports plus the reference corpus and writes new files only.

## Inputs (read-only)

- Fixed population:
  `artifacts/person-benchmark/current-fixed-judge7-recovery1-2026-09-06/fixed-documents-expanded-reassessed-bbc8e62af386b229.json`
  sha256 `c5ae879b7503fa1cd7f284690cc08cfc571d022e064e69371325140a038009fd`
- Incumbent population:
  `artifacts/person-benchmark/current-incumbent-judge7-recovery1-2026-09-06/live-discovery-incumbent-reassessed-f93fe67376b87cec.json`
  sha256 `1381d4e4002ecdd97d0f1ebcb4f50b4818663549b973d378e71d88fe6d2c161d`
- Expanded population:
  `artifacts/person-benchmark/current-expanded-judge7-2026-09-06/live-discovery-expanded-reassessed-e1b50cd7d30b28a3.json`
  sha256 `c5ef1a27f14c4cd27f937c499e93965fb07dd23d6670deb9d5a0e3a818205a7c`
- Reference corpus `benchmark/person-research/people` at content version
  `cd3bd2a050f51de7` (30 people, 235 facts) — cited for reference-fact text only.
- Context (read, not edited): `docs/research/person-benchmark-validation-2026-09-06.md`
  and `artifacts/person-benchmark/README.md`.

Hashes were recorded before classification and recomputed after; all three
are unchanged (see the integrity proof in the PR body). The issue's counts
are confirmed exactly as measured: **59 of 235 fixed, 23 of 235 incumbent,
51 of 235 expanded** — no reconciliation difference. (The issue's "latest
live run reached 130 of 235" refers to a different, non-retained run and is
out of scope here.)

## Method

`scripts/person-ambiguity-classification.mts` (deterministic, no LLM calls)
loads each report through `BenchmarkReportSchema`, walks every per-person
`completeness.judgements` entry with `verdict === "ambiguous"`, and assigns
one cause in `apps/server/src/person-benchmark/ambiguity.ts` by inspecting,
in order:

1. The rationale markers written by the judge/evaluator seams —
   `The judge did not return a usable verdict for this run.` (reference-phase
   judge exception, evaluate.ts), `Original semantic verdict: …; downgraded
   to ambiguous because …` (evaluate.ts credit gate — the because-clause is
   parsed, so only a clause citing incomplete support attributes a support
   cause; an overclaim/integrity-only clause is its own downgrade cause), and `(Downgraded: the
   quoted dossier text does not occur in the dossier.)` (exact-claim guard,
   judge.ts).
2. Whether a claim and dossier quote were cited (`claimId`, `evidenceQuote`).
3. Whether the named claim ID resolves positively anywhere in the report
   (overclaims, integrity finding subjects, `sourceContributions` claim IDs,
   unresolved support findings). Those lists are partial, so a miss proves
   nothing: an unresolvable ID stays explicitly undetermined rather than
   being labeled unknown.
4. Normalized quote comparisons: evidence-vs-reference equality, and
   evidence-vs-retained-cited-passage prefix equality for the same claim.
5. The dossier's retained claim count (`richness.claims`) and the
   support-phase status/failure/unresolved findings.

Sidecar audit: all 390 `*.person.json` / `*.operation.json` sidecars across
the retained directories were searched — none carries dossier claim
statements or claim citations (the word "citations" in 66 sidecars is lead
URL text such as scholar.google.com/citations). The classification therefore
rests on the report-embedded retained lists named above. The full dossier
claim inventory (statements) is not retained anywhere, which is exactly what
bounds the `undetermined-quote-mismatch` residue below.

Outputs (committed):
`artifacts/person-benchmark/ambiguity-classification-2026-09-06/classification.json`
(all 133 records with verdict/claim/citation basis) and `.md` (tables plus
one example per cause). Core unit tests:
`tests/src/modules/person-benchmark-ambiguity.test.ts` (13 tests, one
synthetic fixture per cause plus the unknown bucket).

## Distribution

| Cause | Fixed (59) | Incumbent (23) | Expanded (51) | Total (133) |
| --- | --- | --- | --- | --- |
| empty-dossier-no-evidence | 54 | 18 | 0 | 72 |
| judge-call-failed | 0 | 0 | 28 | 28 |
| undetermined-quote-mismatch | 0 | 5 | 10 | 15 |
| no-evidence-cited-nonempty-dossier | 0 | 0 | 10 | 10 |
| quote-matches-reference-text | 5 | 0 | 0 | 5 |
| judge-quoted-citation-passage | 0 | 0 | 1 | 1 |
| unresolved-support-observation | 0 | 0 | 1 | 1 |
| integrity-overclaim-downgrade | 0 | 0 | 0 | 0 |
| support-assessment-failed | 0 | 0 | 1 | 1 |
| unknown-claim-id | 0 | 0 | 0 | 0 |
| judge-semantic-ambiguous | 0 | 0 | 0 | 0 |

Person-level detail: fixed empty-dossier cases are ana-botin (11),
cary-fowler (10), laurent-freixe (9), minouche-shafik (10),
ngozi-okonjo-iweala (5) and ramon-laguarta (9); incumbent empty-dossier
cases are laurent-freixe (9) and ramon-laguarta (9). Expanded
judge-call-failed cases are doug-mcmillon (8), rodolphe-saade (10) and
tedros-adhanom-ghebreyesus (10) — all three reference assessments failed
when the request ceiling fired mid-call. Expanded no-evidence cases are all
ana-botin (10 verdicts, dossier holds 4 claims, none cited).

## Cause notes and downstream fixes

- **empty-dossier-no-evidence (72).** The judge returned a non-missing
  verdict on a dossier with zero claims, naming no claim and quoting
  nothing; the guard correctly forced ambiguous. Fix: judge prompt —
  short-circuit an empty dossier to missing with no evidence (judge.ts
  recovery prompt).
- **judge-call-failed (28).** The reference-phase judge call threw (retained
  failure: request ceiling fired mid-call, HTTP 200 with bytes on the wire).
  Fix: judge reliability — reference-phase call ceiling/binding recovery
  (judge.ts; the judge-failure fallback in evaluate.ts).
- **undetermined-quote-mismatch (15, explicitly unknown).** The named claim
  is retained (every one resolves via sourceContributions), but its quote
  matches neither the reference wording nor any retained cited passage, and
  the claim statements themselves are not retained — so truncation,
  paraphrase, citation-quote, or language mismatch cannot be told apart. No
  code fix is attributable; fix instead the evidence retention: keep the
  full dossier claim inventory (statements) in reassessment evidence
  (evidence.ts). This is the residue the issue requires to stay unknown.
- **no-evidence-cited-nonempty-dossier (10).** Same shape as the empty
  variant, except ana-botin's expanded dossier holds 4 claims the judge
  never cited. Fix: judge citation discipline — require a claimId plus a
  verbatim claim excerpt for every non-missing verdict (judge.ts recovery
  prompt; the guard stays).
- **quote-matches-reference-text (5).** All five are anders-danielsson
  (fixed): the normalized evidence quote equals the normalized reference
  quote (the judge added a trailing period), while the named claim is
  retained via integrity findings and sourceContributions. The judge quoted
  the reference wording, not a verbatim excerpt of the claim. Fix: judge
  quoting discipline plus trailing-punctuation normalization in the
  exact-claim guard (judge.ts).
- **judge-quoted-citation-passage (1).** arvind-krishna/research-career
  (expanded): the evidence quote is a truncated prefix of the retained
  citedQuote for the same claim (`eee96146…`), while the claim's own
  statement differs ("director of IBM Research" vs the passage's
  "director, IBM Research"). The judge quoted the cited source passage
  rather than the claim text — the issue's candidate, proven. Fix: judge
  quoting discipline — quote the matched claim statement, never the
  citation passage (judge.ts recovery prompt).
- **unresolved-support-observation (1).** laurent-freixe/nestle-ceo
  (expanded): the verdict was partial on claim `c8ddd0dc…`, but the
  person's support phase failed on an unresolved observation against a
  different claim (`fbbedfe8…`, pre-litigation-settlement-talks inference),
  so all positive credit was withheld. Fix: support observation
  resolution — judge support prompt plus verbatim-statement/citation-index
  discipline (validFinding in judge.ts).
- **integrity-overclaim-downgrade (0).** No retained verdict hits this path:
  an evaluator downgrade whose because-clause cites only a validated
  overclaim finding and/or failed critical integrity checks (never
  incomplete support) would land here. Attribution parses the
  because-clause so a future overclaim/integrity downgrade cannot be
  mislabeled as a support failure. Fix: evaluate.ts credit gate
  (factualReliability seam); the downgrade is working as intended.
- **support-assessment-failed (1).** mary-barra/gm-ceo (expanded): partial
  on claim `2aa64bc2…`, downgraded because the support/usefulness call hit
  the request ceiling (no unresolved findings). Fix: judge reliability for
  the support/usefulness phase plus the AssessmentSchema contract
  (judge.ts; evaluate.ts). Adjacent, uncounted: sn-subrahmanyan's support
  call failed on a missing-`overclaims` schema error but produced no
  ambiguous verdicts (empty dossier, all missing).

## Candidate reconciliation (what the issue hypothesized vs the record)

- Judge quoting a cited passage rather than the claim text: **confirmed,
  1 case** (arvind-krishna/research-career, proven against the retained
  citedQuote).
- A claim that paraphrases the reference fact: **0 as an ambiguity cause**.
  Paraphrase cannot trip the guard (the guard compares quote to claim, not
  claim to reference — a paraphrasing claim with a correct verbatim quote
  passes), and zero genuine judge-ambiguous verdicts survive in the data
  (see below), so no paraphrase-driven ambiguity is retained anywhere.
- A claim in a different language from its citation: **not determinable** —
  claim statements are not retained, so claim language cannot be checked.
  Language correlates with mechanism (fixed ambiguous: 34 en, 11 es, 9 fr,
  5 sv per the report language groups; the es/fr cases are all
  empty-dossier, the sv cases all quote-matches-reference) but no
  language-mismatch cause is assigned. Any future claim-inventory retention
  should re-test this hypothesis first on the Swedish/French/Spanish facts.
- An unresolved support observation: **confirmed, 1 case**
  (laurent-freixe/nestle-ceo).
- An unknown claim ID: **refuted, 0 cases** — all 21 judge-named claim IDs
  resolve positively in retained claim-ID lists (sourceContributions,
  integrity subjects, overclaims), so none required an absence judgment.
  The classifier deliberately never infers "unknown" from absence: the
  retained lists are partial, and an unresolvable ID would stay explicitly
  undetermined. The judge never invents an ID in this data; it mis-quotes
  known ones.
- Genuine judge uncertainty (`judge-semantic-ambiguous`, guard passed, no
  downgrade): **0 cases**. Every retained ambiguous verdict carries a
  pipeline marker — the ambiguity in this data is mechanical (guard,
  downgrade, or call failure), never a bare "cannot tell".

## Example assignments (verdict / claim / citation)

1. expanded arvind-krishna/research-career → judge-quoted-citation-passage.
   Verdict `research-career=ambiguous`; claim `eee96146…` retained via
   overclaims; evidence quote ("Arvind Krishna is senior vice president
   and director, IBM Research. In this role, he helps guide the company's
   overall technical s…") is a strict prefix of the retained citedQuote
   for the same claim, while the claim statement reads "…director of IBM
   Research, guiding…". Guard downgrade present.
2. expanded laurent-freixe/nestle-ceo → unresolved-support-observation.
   Verdict `nestle-ceo=ambiguous` (originally partial) on claim
   `c8ddd0dc…` with evidence "Laurent Freixe was CEO of Nestlé, fired
   from the role in September 2025…"; support phase failed with one
   unresolved observation naming claim `fbbedfe8…` (unsupported
   pre-litigation-talks inference), withholding all positive credit.
3. fixed anders-danielsson/skanska-ceo → quote-matches-reference-text.
   Verdict `skanska-ceo=ambiguous`; claim `3b7117fb…` retained via
   integrity findings and
   sourceContributions:documents-publishers; normalized evidence quote
   equals the normalized Swedish reference quote (judge added a trailing
   period), so the verbatim-substring guard failed.
