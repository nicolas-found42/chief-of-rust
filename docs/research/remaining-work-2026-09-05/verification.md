# Final acceptance evidence

Baseline: `b6c85a64775e8f62e69e87fd3b1c8b6f5e9f6b50`. This document records the remaining-work diff,
not the earlier audit's results. The unrelated `.claude/skills/handoff/SKILL.md` deletion is excluded.

## Completed local proof

- `pnpm run check:all` passed on 2026-09-05: **171 unit test files / 1,880 tests**, all typecheck,
  lint, formatting and knip checks, production build, and **80/80 Playwright journeys**.
- The final cold-cache `check:all` passed over the complete diff, including section freshness.
  TypeScript build information, ESLint cache and Prettier cache were removed first. The durable
  output is [cold-check-all.log](cold-check-all.log); process exit code was 0.
  Saved logs normalize trailing whitespace only.
- Shared Google Tasks/Asana synchronization suite: **84 tests passed**, including reconnect versus
  unchanged restart, failed-read suppression, uncertain initial/replacement creation, explicit
  record-ID recovery, and preserving/pushing local completion after a lost response.
- Queue suite: **14 tests passed**, including a real child-process SIGKILL during extraction,
  cumulative allowances, daily rollover without replay or scope loss, fair concurrent dispatch,
  and archive/correction/merge/privacy/pause/gate/stop/material-evidence fences.
- Weekly suite: **26 tests passed**, including source exclusion/output contract, finite field and
  source counts, consent/corruption, independent scheduled refresh, original dirty deadlines after
  restart, shutdown fencing, concurrent email calls and lost acknowledgement after reconstruction.
- Canonical cutover suite: **4 tests passed**, including real atomic-write failure, reconstructed
  retry, stale preview, idempotent receipt, preserved records and invalid receipt rejection.
- Production Shell composition: **13 tests passed**. The new entry test exercises manual, typed,
  Calendar, repeated Transcript and legacy backfill through the composed queue with remote I/O
  faked. Unrelated content schedules are parked and pending runtimes drain before teardown.
- The browser matrix includes new open-page Weekly Task updates, canonical preview/cancel/execute,
  byte-preserving gated boot, historical and unquoted dossier source inspection, sparse/unavailable
  keyboard/mobile accessibility, and Calendar/repeated-Transcript creation-to-source journeys.
- Private-only supported/contested dossier DOM fixtures and source/query lifecycle suites pass.
- Independent [Standards review](standards-review.md) and [Spec review](spec-review.md) have no
  unresolved confirmed finding. Their reports describe scope and do not substitute for these gates.
- `git diff --check` passed. Debrief prompt, Result Shape and Goldens did not change, so the paid
  Debrief Prompt Eval is not applicable to this diff.

## Real-source evidence and limits

The refreshed `../person-dossier-canary.json` ran two public identities against the configured
provider/model with eight operations and 120 seconds per Profile. Both were incomplete: Simon
Willison's extraction returned non-JSON; Rich Hickey's known page was blocked and discovered
results lacked established identity. No extracted claims/work in this run. Latency was about
17.2 and 11.0 seconds, respectively. Token usage and cost are unavailable, not zero. Retained
matched text survives extraction failure. This evidence is not a successful quality benchmark.

No live email, remote Task creation, tracker mutation or live Workspace cutover was performed.
Fake adapters prove outward-write semantics; they do not certify availability of the owner's
provider accounts.

## Final cold and production gates

Cold gate complete (exit 0). The unchanged Dockerfile built successfully as
`chief-remaining-acceptance:20260905`, image ID
`sha256:2d892fb77de285169ca7b353bb563a62d2516f8b4713cc3a0852a901e0bbd620`.
The first attempt timed out on Docker Hub metadata. A temporary anonymous Docker client config
bypassed the credential-helper path; no repository Dockerfile or user configuration was changed.
The successful [build log](docker-build.log) includes the runtime binary smoke checks.

The image booted with a fresh anonymous Workspace volume, no credentials or test seed, and
`127.0.0.1:52373`. `/api/health` returned exactly `{"ok":true}`; migration status, Tasks, Lists,
Action Items and People APIs returned 200. A real Chromium browser followed all five product
navigation links, verified active navigation and rendered headings, and reported no page errors.
The [machine-readable proof](production-proof.json) and [inspected screenshot](production.png)
record that run. The first browser probe had an assertion timing race; the final probe used
retrying navigation assertions and passed. Default content scheduling performed public search
reads during boot; it had no provider credentials and sent no email or remote Tasks.

The proof container and its anonymous volume were removed. The existing `chief-dossier-audit-proof`
container, its volume and loopback port 44317 remain intact. This isolated build/boot fulfills the
production-image gate without replacing the owner's live deployment.

## Live operation

The repository's configured Workspace preview is in [live-preview.json](live-preview.json).
[Preservation evidence](live-preview-preservation.json) confirms all 22 files have the same digest
before and after preview. Counts are zero for legacy Runs, receipts and canonical work.
The [runbook](live-cutover-runbook.md) and [tracker drafts](tracker-updates.md) are prepared.
#202 still requires fresh exact-Workspace authorization, authorization recorded on the issue,
execution, receipt and post-cutover validation. Local test success does not satisfy that live gate.
