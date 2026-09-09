# Ambiguous semantic verdict classification — 2026-09-06

Every ambiguous verdict in the retained populations, each assigned one named cause. Causes that cannot be decided from retained evidence are explicitly undetermined.

## Inputs (read-only; sha256 recorded before parsing)

- **fixed**: `artifacts/person-benchmark/current-fixed-judge7-recovery1-2026-09-06/fixed-documents-expanded-reassessed-bbc8e62af386b229.json` sha256 `c5ae879b7503fa1cd7f284690cc08cfc571d022e064e69371325140a038009fd` — 59 ambiguous of 235 facts
- **incumbent**: `artifacts/person-benchmark/current-incumbent-judge7-recovery1-2026-09-06/live-discovery-incumbent-reassessed-f93fe67376b87cec.json` sha256 `1381d4e4002ecdd97d0f1ebcb4f50b4818663549b973d378e71d88fe6d2c161d` — 23 ambiguous of 235 facts
- **expanded**: `artifacts/person-benchmark/current-expanded-judge7-2026-09-06/live-discovery-expanded-reassessed-e1b50cd7d30b28a3.json` sha256 `c5ef1a27f14c4cd27f937c499e93965fb07dd23d6670deb9d5a0e3a818205a7c` — 51 ambiguous of 235 facts

Corpus `benchmark/person-research/people` version `cd3bd2a050f51de7` (reference-fact citations only).

## Counts per cause per population

| Cause | fixed | incumbent | expanded | Total |
| --- | --- | --- | --- | --- |
| judge-call-failed | 0 | 0 | 28 | 28 |
| support-assessment-failed | 0 | 0 | 1 | 1 |
| unresolved-support-observation | 0 | 0 | 1 | 1 |
| integrity-overclaim-downgrade | 0 | 0 | 0 | 0 |
| empty-dossier-no-evidence | 54 | 18 | 0 | 72 |
| no-evidence-cited-nonempty-dossier | 0 | 0 | 10 | 10 |
| quote-matches-reference-text | 5 | 0 | 0 | 5 |
| judge-quoted-citation-passage | 0 | 0 | 1 | 1 |
| unknown-claim-id | 0 | 0 | 0 | 0 |
| judge-semantic-ambiguous | 0 | 0 | 0 | 0 |
| undetermined-quote-mismatch | 0 | 5 | 10 | 15 |

Total ambiguous verdicts classified: 133.

## Example assignments

### judge-call-failed

- doug-mcmillon/walmart-ceo (expanded): claim=null, evidence=null, reference="President and CEO, Walmart, Inc.In officeFebruary 2014 – January 2026Preceded byMike DukeSucceeded byJohn Furner"
  - verdict walmart-ceo=ambiguous (doug-mcmillon/expanded)
  - rationale is exactly "The judge did not return a usable verdict for this run."
  - phases.reference.failure="Judge reference assessment failed: openrouter: a model call was in flight when the request ceiling fired (model z-ai/glm-5.3-flash, binding forced_tool_call, HTTP 200, 5909 bytes, ceiling 30000ms)"
  - richness.claims=0
  - Fix: Judge reliability: reference-phase call ceiling/binding recovery (apps/server/src/person-benchmark/judge.ts; judge-failure fallback in evaluate.ts).

### support-assessment-failed

- mary-barra/gm-ceo (expanded): claim=2aa64bc24adf45a7f9c71df2de5664f6, evidence="Mary Barra was named CEO of General Motors in 2013, at age 52.", reference="has been the chair[1] and chief executive officer (CEO) of General Motors since January 15, 2014"
  - verdict gm-ceo=ambiguous (mary-barra/expanded)
  - rationale starts with "Original semantic verdict: partial" downgraded for an incomplete support/usefulness assessment
  - phases.support.status=failed
  - phases.support.failure="Judge support/usefulness assessment failed: openrouter: a model call was in flight when the request ceiling fired (model z-ai/glm-5.3-flash, binding forced_tool_call, HTTP 200, 41262 bytes, ceiling 30000ms)"
  - no unresolved support observations are retained for mary-barra
  - Fix: Judge reliability: support/usefulness-phase call robustness and the AssessmentSchema contract (judge.ts; evaluate.ts).

### unresolved-support-observation

- laurent-freixe/nestle-ceo (expanded): claim=c8ddd0dcbc16efc317573f8fe9cc62cb, evidence="Laurent Freixe was CEO of Nestlé, fired from the role in September 2025 after holding the post for about 12 months.", reference="he became its chief executive in 2024, until losing the position about a year later, in September 2025"
  - verdict nestle-ceo=ambiguous (laurent-freixe/expanded)
  - rationale starts with "Original semantic verdict: partial" downgraded for an incomplete support/usefulness assessment
  - phases.support.status=failed
  - phases.support.failure="Judge support findings named unknown claims or statements that are not verbatim excerpts of their named claims, or invalid citation selections."
  - unresolved support observations name claim(s): fbbedfe8
  - this verdict's claim (c8ddd0dc) is withheld credit regardless of which claim was unresolved
  - Fix: Support observation resolution: judge support prompt plus verbatim-statement and citation-index discipline (validFinding in judge.ts).

### integrity-overclaim-downgrade (0 assignments)

### empty-dossier-no-evidence

- ana-botin/santander-chair (fixed): claim=null, evidence=null, reference="is a Spanish banker who has been the executive chairman of Santander Group since 2014"
  - verdict santander-chair=ambiguous (ana-botin/fixed)
  - rationale carries the exact-claim-guard downgrade "(Downgraded: the quoted dossier text does not occur in the dossier.)"
  - claimId=null and evidenceQuote=null: the judge named no claim and quoted no dossier text
  - richness.claims=0: the dossier holds no claim that could have been cited
  - Fix: Judge prompt: short-circuit an empty dossier to missing with no evidence instead of a non-missing verdict without evidence (judge.ts recovery prompt).

### no-evidence-cited-nonempty-dossier

- ana-botin/santander-uk-ceo (expanded): claim=null, evidence=null, reference="In November 2010, Botín succeeded António Horta Osório as chief executive of Santander UK"
  - verdict santander-uk-ceo=ambiguous (ana-botin/expanded)
  - rationale carries the exact-claim-guard downgrade "(Downgraded: the quoted dossier text does not occur in the dossier.)"
  - claimId=null and evidenceQuote=null: the judge named no claim and quoted no dossier text
  - richness.claims=4: the dossier holds claims, none of them cited
  - Fix: Judge citation discipline: require a claimId plus a verbatim claim excerpt for every non-missing verdict (judge.ts recovery prompt; the exact-claim guard stays).

### quote-matches-reference-text

- anders-danielsson/skanska-ceo (fixed): claim=3b7117fbf5f1c48b3e708df894340820, evidence="Danielsson tillträdde som verkställande direktör och koncernchef för Skanska den 1 januari 2018.", reference="Danielsson tillträdde som verkställande direktör och koncernchef för Skanska den 1 januari 2018"
  - verdict skanska-ceo=ambiguous (anders-danielsson/fixed)
  - rationale carries the exact-claim-guard downgrade "(Downgraded: the quoted dossier text does not occur in the dossier.)"
  - claimId 3b7117fb is retained via integrity findings for anders-danielsson, so the ID is known and the guard failed on the quoted text
  - normalized evidenceQuote equals normalized referenceQuote; the judge quoted the reference wording, not a verbatim excerpt of the named claim
  - Fix: Judge quoting discipline plus guard normalization: quote the supplied dossier claim rather than the reference wording, and normalize trailing punctuation in the exact-claim guard (judge.ts).

### judge-quoted-citation-passage

- arvind-krishna/research-career (expanded): claim=eee961468990279fc0e74c23c3ef405a, evidence="Arvind Krishna is senior vice president and director, IBM Research. In this role, he helps guide the company’s overall technical strategy, leading a global organization of approximately 3,000 scientists and technologists located at 12 labs on six continents.", reference="Krishna joined IBM's Thomas J. Watson Research Center in 1990, and continued in Watson Research for 18 years until 2009."
  - verdict research-career=ambiguous (arvind-krishna/expanded)
  - rationale carries the exact-claim-guard downgrade "(Downgraded: the quoted dossier text does not occur in the dossier.)"
  - claimId eee96146 is retained via overclaims for arvind-krishna, so the ID is known and the guard failed on the quoted text
  - evidenceQuote is a prefix of (or equals) the retained citedQuote for the same claim, so the judge quoted the claim's cited source passage rather than the claim statement
  - Fix: Judge quoting discipline: quote the matched dossier claim statement, never the claim's cited source passage (judge.ts recovery prompt).

### unknown-claim-id (0 assignments)

### judge-semantic-ambiguous (0 assignments)

### undetermined-quote-mismatch

- hilary-cottam/radical-help (incumbent): claim=cee8e3d8ba33eb1c98f8433e427255d2, evidence="In her new book Radical Help: How We Remake the Relationships Between Us and Revolutionise the Welfare State", reference="Cottam is the author of Radical Help: how we can remake the relationships between us and revolutionise the Welfare State"
  - verdict radical-help=ambiguous (hilary-cottam/incumbent)
  - rationale carries the exact-claim-guard downgrade "(Downgraded: the quoted dossier text does not occur in the dossier.)"
  - claimId cee8e3d8 is retained via sourceContributions:historical-evidence for hilary-cottam, so the ID is known and the guard failed on the quoted text
  - evidenceQuote matches neither the reference wording nor any retained cited passage for this claim, and the dossier claim statements are not retained, so the exact mismatch cannot be decided
  - Fix: Evidence retention: retain the full dossier claim inventory (statements) in reassessment evidence so the mismatch can be decided (evidence.ts); no code fix is attributable from retained evidence.

