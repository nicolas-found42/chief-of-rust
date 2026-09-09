# chief-of-rust — Found42

The Rust rewrite of
[chief-of-staff-demo](https://github.com/nicolas-found42/chief-of-staff-demo) —
Found42's local meeting and content workflows. The TypeScript implementation was
deleted in one cutover
([#8](https://github.com/nicolas-found42/chief-of-rust/issues/8)); this repo
starts Rust-only.

## Layout

A cargo workspace with one crate:

- `crates/app` — the walking skeleton (prototype for
  [#2](https://github.com/nicolas-found42/chief-of-rust/issues/2)): an axum +
  Askama SSR app over SQLite (rusqlite), a background tick task, an LLM call
  behind an app-local provider trait (mock by default), and a Google Calendar
  call behind the installed OAuth flow — packaged in Docker and exercised by
  the CI boot check. It exists to make the stack survey (#3) reactable, not to
  be the final shape.

Kept from the previous stack because it is infrastructure, not TypeScript:
`docker-compose.yml` (app + searxng + valkey) and `searxng/`.

## Working on it

```sh
cargo test --workspace                                   # tests
cargo fmt --all -- --check                               # format
docker compose build app && docker compose up -d --wait app   # image + boot
curl -fsS http://127.0.0.1:4317/                              # SSR page
```

CI (`.github/workflows/ci.yml`) runs five checks on every PR: `fmt`, `check`,
`clippy`, `test`, `image`. Every change to `main` goes branch → PR → squash
merge behind all five green — see `docs/agents/pr-workflow.md`.

## Agent rules

`AGENTS.md` is the entry point; the per-topic rules live in `docs/agents/`.

Product background that predates the rewrite and still applies:
[questionnaire-answers.md](questionnaire-answers.md) and
[to-questionnaire-content-and-meeting-workflows.md](to-questionnaire-content-and-meeting-workflows.md).
