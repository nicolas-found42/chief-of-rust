# Orchestrator Loop Gate — TODO

Fixed point: `8feea68` (`8feea68255448674498f7688d2dcfb61e9b36f91`) validated via `git rev-parse 8feea68` and `git diff 8feea68...HEAD --stat` (non-empty, 93 files at HEAD `7dca891`). Spec source: #41 Content Scout (binding) + sub-issues #49–61 + `CONTEXT.md` + `docs/adr/0028`. Standards: `AGENTS.md`, `CONTEXT.md`, `docs/agents/verification.md`, `eslint.config.js` boundary rules, ADRs. Baseline report: `artifacts/orchestrator/baseline-round-1.md` (and per-round `artifacts/orchestrator/round-*.md` with `## Standards` and `## Spec` headings, ending one-line summary per axis and worst issue).

Gate success: Standards hard-violations == 0 && Spec missing/wrong == 0. Smells are warnings, not gate failures.

Umbrella: #42. All follow-ups are P2 and reference not duplicate spec.

## Phase 1 — Follow-up issues (7 P2s for the gate findings)

Created 2026-08-27, each body contains `Part of #42`, `Spec ref: #41 … / #<sub-issue>`, `Finding:`, `Acceptance` (observable contract: `npm run typecheck` + adapter contract test) and `Verification` (narrowest per `docs/agents/verification.md` + whole-tree `npm run check`). Labels `ready-for-agent` + `relay-to-modules`, kept under ~200 words.

- [ ] #72 [Content Scout gate] comment ranking retains questions/disagreement up to 50 — Spec #41 US 49–50 / #52, #58 — caps 30 vs 50 + no question/disagreement ranking
- [ ] #73 [Content Scout gate] discovery similarity factors include domain and category — Spec #41 US 121–122 / #56 — similarity factors not domain/category
- [ ] #74 [Content Scout gate] per-adapter fixture files replace simulated coverage — Spec #41 US 44, 129–131 / #59 — fixture coverage simulated not per-adapter files
- [ ] #75 [Content Scout gate] LinkedIn canary persistence connects host and runner — Spec #41 US 24 / #61 — host.ts reads `linkedin-canaries.json` never written by `ContentScoutCanaryRunner`
- [ ] #76 [Content Scout gate] Substack unavailable stays unavailable not failed — Spec #41 US 44 / #50 — unavailable→failed conflation
- [ ] #77 [Content Scout gate] YouTube causeChain keeps unsupported distinct — Spec #41 US 44, 130 / #52 — causeChain aggregation obscuring unsupported
- [ ] #78 [Content Scout gate] website empty-shell detection distinguishes rendering need — Spec #41 US 39–40, 44 / #49 — empty-shell detection

Verify: `gh issue list --state open --search "Content Scout gate"` shows 7 open issues with the required body sections.

## Phase 2 — Codify orchestrator script

- [ ] Write persistent checklist (this file) + executable script `scripts/orchestrator-loop-gate.mjs` (or equivalent) that loops `skill://code-review` against fixed point `8feea68...HEAD` until green, then wires fixes per finding
- [ ] Script persists per-round reports under `artifacts/orchestrator/` with `## Standards` and `## Spec` headings verbatim, ends with one-line summary per axis and worst issue within each axis
- [ ] Script resolves prerequisites first, uses `gh` for issue operations, infers repo from `git remote`, does not duplicate spec text beyond references
- [ ] `artifacts/` directory exists; script + checklist pass `prettier`/`eslint` when written (no project-wide `npm run check` required in subagents)

## Phase 3 — Wire fixes into the loop via isolated worktrees

- [ ] For each finding above, run `skill://implement` (or equivalent) on an isolated worktree/branch per issue, implementing the Acceptance contract and its narrowest gate test
- [ ] Keep `8feea68` fixed; do not move base; each worktree merges only its scoped fix, migrates every caller, removes obsolete code/comments
- [ ] Do not run project-wide formatters/linters/tests inside subagents unless task explicitly requires verification; orchestrator script itself must pass `prettier`/`eslint` when written

## Phase 4 — Verify gate

Run at the fixed point `8feea68` → `HEAD`:

- [ ] `git rev-parse 8feea68` returns `8feea68255448674498f7688d2dcfb61e9b36f91`
- [ ] `git diff 8feea68...HEAD --stat` shows 93-file delta (non-empty)
- [ ] `npm run check` (typecheck + lint + format:check + knip + unit tests) — whole-tree gate
- [ ] If Docker daemon available: `docker compose build` + `docker compose up -d` + `curl --fail http://127.0.0.1:4317/api/health` returns `{"ok":true}` then `docker compose down` (per `docs/agents/verification.md` production image gate)
- [ ] Narrowest gates per issue (see issue Verification sections) are green before whole-tree

Persist the green report as `artifacts/orchestrator/round-N.md` (or `local://` equivalent) with `## Standards` / `## Spec` and gate-success line.

## Phase 5 — Merge only after green

- [ ] Merge only when Standards hard-violations == 0 && Spec missing/wrong == 0 (smells are warnings) and every per-round report ends with one-line summary per axis and worst issue within each axis
- [ ] Update affected callsites/tests/docs for each fix; no shims or deprecated paths unless explicitly retained
- [ ] Close follow-ups via the loop, keep umbrella #42 open until all native sub-issues (#49–61) and these 7 gates are green

---

### Quick verify

```sh
git rev-parse 8feea68
git diff 8feea68...HEAD --stat
gh issue list --state open --search "Content Scout gate" --json number,title,body | jq -r '.[].number'
ls artifacts/orchestrator/
cat docs/orchestrator-loop-gate-todo.md
```
