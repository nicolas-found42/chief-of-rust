# Issue #228 validation artifacts

The root-level historical reports and the diagnostics subdirectory are smoke evidence, not
proof that issue #228's full quality acceptance criteria have passed. The configured research and judge model was OpenRouter `z-ai/glm-5.3-flash`.
All research ran in temporary workspaces.

- `fixed-documents-expanded-2d0a903133188b6a`: authoritative corrected smoke run for Achim
  Steiner and Ana Botín. Both research operations were interrupted by model extraction
  timeouts; the report is correctly **failed**, with zero recovered facts. The per-person
  operation JSON files preserve the attempts. Judge responses do not establish successful
  research when extraction failed.
- `fixed-documents-expanded-8620f6e645bedd41`: earlier diagnostic run, retained unchanged for
  traceability. Its top-level completed status is **incorrect**: both nested operations were
  interrupted. This exposed the evaluator bug fixed before the corrected run. Do not use it
  as a successful baseline or quality result.

The [diagnostics index](diagnostics-2026-09-06/README.md) includes later preserved failures and
completed tiny production smoke `39e8f583d614ad67`. That smoke recovered one of one dated
reference facts with complete integrity and semantic assessment. Its tiny corpus does not
substitute for the full benchmark.

The `full-fixed-2026-09-06` run `96a666d0479437eb` finished all 30 research operations. It
published zero claims and recovered zero of 235 reference facts: 22 operations were interrupted,
eight completed without claims, and 28 of 30 semantic assessments completed. This is a failed
acceptance run. Its saved evidence passed reassessment validation. A new `.5` reassessment was
started, then stopped without a saved report when corrected full research runs superseded it.

The `full-incumbent-2026-09-06` and `full-expanded-2026-09-06` directories contain **superseded
partial diagnostic runs**, stopped after 19 and 10 saved operations respectively to reduce
competing model requests. Their operation records and public snapshots remain preserved;
neither is a completed population assessment or a comparable acceptance arm.

The `current-fixed-2026-09-06`, `current-incumbent-2026-09-06` and
`current-expanded-2026-09-06` directories contain the new full runs against corrected matching
inputs. All three have finished all 30 people. Fixed
published seven claims, recovered two reference facts and completed 26 semantic assessments.
Incumbent published 48 claims, recovered two reference facts and completed 29 semantic
assessments. Expanded published 79 claims, credited zero recovered facts and completed 25
semantic assessments; all 30 research operations were interrupted. These original `.5` reports
remain failed and are not final acceptance measurements.
Live arms both use operation concurrency two; all runs retain public evidence directly.

The `current-fixed-judge7-2026-09-06` and `current-incumbent-judge7-2026-09-06` directories
contain full reassessments of those saved populations. The fixed first pass completed 28
assessments; `current-fixed-judge7-recovery1-2026-09-06` run `bbc8e62af386b229` carried those
28 and retried only two failures, completing all 30 plus the collection scenario. It recovers
2 of 235 facts with zero critical integrity findings and zero wrong-person findings. Original
research remains 23 interrupted operations and seven completed operations; the report is failed.
Five Anders Danielsson matches remain ambiguous because the judge quoted cited passages instead
of the selected claim text. These completed adverse assessments are fixed, not retried.

The incumbent first pass completed 24 assessments; failed-only recovery
`f93fe67376b87cec` in `current-incumbent-judge7-recovery1-2026-09-06` completed all 30 and the
collection scenario. It records zero recovered facts and eight partial matches. The `.7` judge validates
support findings and their selected citations before recovery credit; reassessment enforces
immutable evidence and preserves original research outcomes. Completed per-person assessments
are saved as versioned sidecars. A valid baseline/candidate comparison remains outstanding. See
[the validation record](../../docs/research/person-benchmark-validation-2026-09-06.md).

The original full runs use corpus `3dedb8c8e53a4f4c` and judge `.4`. Subsequent review corrected
three malformed employer hints (new corpus `cd3bd2a050f51de7`) and the judge's full-input contract
(new judge `.5`). Original measurements retain their original identities; they cannot be
silently relabeled as current-configuration acceptance results.

Tracing the expanded misses identified a production reader defect: Wikipedia editing JavaScript
mentions CAPTCHA, which the previous access detector falsely treated as a bot challenge. The
diagnostics directory contains before/after evidence from the normal HTTP 200 article response
and a production reader check. The corrected reader version is `2026-09-06.1`.
`reader-fixed-expanded-2026-09-06` is a fresh full live expanded run with that repair, unchanged
references/model/allowances and judge `.7`. It remains in progress. Earlier source evidence
cannot acquire rejected articles through reassessment and remains unchanged.

The completed older-expanded `.7` reassessment `e1b50cd7d30b28a3` has 24 complete assessments
and six failures. Its CLI comparison in `pre-reader-repair-comparison-2026-09-06` correctly
returns `not-comparable` and exit 1. It has an explicitly rejected positive: Ana Botín's
chairmanship was called recovered even though the judge's rationale says the required date and
family detail are missing. Do not treat that positive alone as the required improvement.

## Frozen acceptance corpus (#243)

Corpus `14bca86ee0b97d28` (content identity from `loadCorpus`, sha256 over the
references themselves) is frozen as the reference for both acceptance arms: 30
people, 277 reference facts, 1 collection scenario
(`directing-and-screenwriting`, requirement r18), zero rejected. Any
reference-content change moves this version, so both arms must cite it for a
comparison to be attributable. Individual-fact coverage across all twenty
dossier requirements (r18 carried solely by the collection scenario) and the
scenario's real-output assessment — missing in both retained `.7`
reassessments (`bbc8e62af386b229` fixed, `f93fe67376b87cec` incumbent; Bong's
operations published zero claims, so the demonstrated set was empty) — are
recorded in
[the collection assessment record](../../docs/research/person-benchmark-collection-assessment-2026-09-06.md).
