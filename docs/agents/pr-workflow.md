# Pull request workflow

Every change to `main` goes `branch → PR → squash merge`, behind five green CI
checks. `main` takes no direct push and no force-push.

This is the outbound workflow. Triaging _inbound_ PRs from outside contributors
is a separate flag in `issue-tracker.md`, currently off.

## The loop

```bash
git switch -c <type>/<slug>     # branch before the first commit
cargo fmt --all -- --check \
  && cargo check --workspace --all-targets --locked \
  && cargo clippy --workspace --all-targets --locked -- -D warnings \
  && cargo test --workspace --locked   # green locally first
git push -u origin HEAD
gh pr create --fill             # --title/--body for anything worth reading
gh pr checks <n> --watch        # the five required checks
gh pr view <n> --json headRefOid --jq .headRefOid
gh pr merge <n> --squash --match-head-commit <head>
```

Read the diff and confirm all five required checks passed for the current head
before merging. Bind the merge to that SHA with `--match-head-commit` so a
concurrent push requires a fresh check.

Done means **merged and green**. A PR left open is unfinished work; say so
rather than reporting the task complete.

`verification.md` has the narrower gates to run while working, before the
whole-tree gate is worth it.

## Naming

`<type>/<slug>`, where `<type>` is the conventional-commit prefix the squash
commit will carry: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`,
`build`. Issue number first when there is one — `chore/8-rust-cutover` — so
the branch, the PR, and the issue share one greppable string.

The squash commit takes the **PR title**, so the title carries the prefix and
the body becomes the commit body. Close the issue from the body with
`Closes #8`.

A branch that falls behind rebases, never merges `main` in:
`git fetch origin && git rebase origin/main`, then
`git push --force-with-lease` on the feature branch.

## The CI gate

Five required checks, all from `.github/workflows/ci.yml`: `fmt` (rustfmt),
`check` (cargo check, all targets, `--locked`), `clippy` (`-D warnings`),
`test` (workspace), `image` (Docker build + boot check).

There is **no enforced ruleset** on this repo: the rulesets and
branch-protection APIs need a public repo or GitHub Pro, and this one is
private on a free plan — both APIs return 403. The gate is therefore the
discipline above: never merge red, never merge a head whose checks you have
not read, and `--match-head-commit` binds every merge to a verified SHA.

Checks are **non-strict** as everywhere on GitHub: a PR merges on a result
that tested it against `main` as it was when the checks ran. Two PRs that each
pass alone can therefore break together. One PR at a time keeps that window
shut.

## Agent authority

Pre-authorized, no prompt:

- Branch, commit, `git push` a feature branch, `--force-with-lease` on one
- `gh pr create`, `gh pr edit`, `gh pr comment`
- `gh pr merge <n> --squash` with `--match-head-commit` on a PR whose five
  required CI checks are green

Ask first, every time:

- Introducing or changing GitHub-enforced branch protection or rulesets
- `gh pr close` on a PR someone else opened
- Deleting a remote branch other than the just-merged PR's own

The gate holds because no one merges red. The agent authenticates as
`nicolas-found42` (`gh auth status` confirms it), so GitHub could not tell the
two apart even if an enforced ruleset existed. Green is the only way through.

## Dependabot

Dependabot PRs merge themselves. `.github/workflows/dependabot-automerge.yml`
enables auto-merge for `dependabot[bot]`, so a green one lands unattended. It
passes the same five checks as everything else.

A red one waits. Report it to Nicolas with the failing check named; merging it
is his call, per PR. The config groups updates weekly on Monday and does not
exclude majors, so a red Dependabot PR is usually a breaking major rather than
a flake — read the failure before assuming a retry helps.
