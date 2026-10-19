# Agent instructions

Rust workspace for Found42's meeting and content workflows. The TypeScript
implementation was deleted in the Rust cutover (issue #8) and lives on in
`../chief-of-staff-demo` and on GitHub. Cargo workspace; the app crate is
`crates/app`; axum serves Askama HTML forms over SQLite with a durable queue.
Generated prose uses OpenCode's BEAM Free (`beam-free`) over Chat Completions.
Meeting debriefs use TypeSafe/Jev through OpenRouter for evidence judgments.

## Agent skills

### Issue tracker

GitHub Issues on `nicolas-found42/chief-of-rust` via the `gh` CLI; specs are
long-form issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to GitHub label strings (`needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), plus a working
vocabulary carried over from `chief-of-staff-demo`. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: the domain vocabulary and the record of settled decisions live
in the issue tracker until the Rust design settles. The TypeScript-era
`CONTEXT.md` and `docs/adr/` were deleted in the cutover; ADRs restart at
`docs/adr/0001` when the rewrite earns them. See `docs/agents/domain.md`.

### Pull requests

Do branch work in a `git worktree`; the user's checkout stays untouched, and
the pushed branch is the delivery. Every change to `main` goes
`branch → PR → squash merge` behind five green CI checks (`fmt`, `check`,
`clippy`, `test`, `image`). Read the checks for the current head, then
`gh pr merge --squash` with `--match-head-commit`; no bypass for anyone. See
`docs/agents/pr-workflow.md`.

### Verification gates

Run the narrowest gate covering the change while working, and the whole-tree
gate before pushing; container changes add a Docker build and boot check. See
`docs/agents/verification.md`.
