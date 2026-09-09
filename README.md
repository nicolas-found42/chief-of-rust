# chief-of-rust — Found42

The Rust rewrite of
[chief-of-staff-demo](https://github.com/nicolas-found42/chief-of-staff-demo) —
Found42's local meeting and content workflows. The TypeScript implementation was
deleted in one cutover
([#8](https://github.com/nicolas-found42/chief-of-rust/issues/8)); this repo
starts Rust-only, and the web framework is not chosen yet.

## Layout

A cargo workspace with one crate:

- `crates/app` — stub binary (`chief-of-rust`). It prints a banner and exits; it
  exists so the workspace, CI, and the Docker image have something real to build
  and boot while the framework decision is open.

Kept from the previous stack because it is infrastructure, not TypeScript:
`docker-compose.yml` (app + searxng + valkey) and `searxng/`.

## Working on it

```sh
cargo test --workspace                                   # tests
cargo fmt --all -- --check                               # format
cargo clippy --workspace --all-targets --locked -- -D warnings   # lint
docker compose build app && docker compose run --rm app  # image boot
```

CI (`.github/workflows/ci.yml`) runs five checks on every PR: `fmt`, `check`,
`clippy`, `test`, `image`. Every change to `main` goes branch → PR → squash
merge behind all five green — see `docs/agents/pr-workflow.md`.

## Agent rules

`AGENTS.md` is the entry point; the per-topic rules live in `docs/agents/`.

Product background that predates the rewrite and still applies:
[questionnaire-answers.md](questionnaire-answers.md) and
[to-questionnaire-content-and-meeting-workflows.md](to-questionnaire-content-and-meeting-workflows.md).
