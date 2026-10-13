# Verification gates

Run the narrowest gate that covers the change while working, then the whole-tree
gate before pushing. Container changes also have to prove the image boots,
because Docker is the only supported way to run the app.

## Gate topology

| Granularity | Gate | What it proves |
| --- | --- | --- |
| Prose only | nothing | Nothing: no gate reads hand-written Markdown; read the rendered diff instead |
| One test | `cargo test -p chief-of-rust <test_name>` | The behavior at the seam currently being changed |
| One crate | `cargo check -p <crate> --all-targets && cargo clippy -p <crate> --all-targets` | The crate compiles and is lint-clean |
| Whole tree | `cargo fmt --all -- --check && cargo check --workspace --all-targets --locked && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked` | Format, compile, lint, and tests across the workspace |
| Production image | `docker compose build app`, then `docker compose up -d --wait app` | The image builds and the binary boots |
| Clean checkout | GitHub Actions on pull requests and pushes to `main` | fmt, check, clippy, test, and the production image boot |

### A prose-only change has no gate

A change touching only hand-wrapped Markdown — `AGENTS.md`, `docs/agents/`, the
README — has nothing for a compile gate to prove. Read the rendered diff
instead, and confirm the hand-wrapping survived: prose is hand-wrapped (see
`CODING_STANDARDS.md`), so a reflow is a finding.

## The `--locked` trap

Every whole-tree gate runs `--locked`. A `Cargo.toml` edit without a matching
`Cargo.lock` update fails `--locked` — that is the point: dependency changes
must land as a reviewed lockfile diff, not as whatever the CI runner resolves
that day. Run plain `cargo check` once to regenerate the lockfile, review the
diff, and include it in the commit.

When changing gate configuration, verify both a clean pass and an intentional
failure at the changed seam.

## Container check

Changes to the Dockerfile, compose file, or dependency tree need this
additional check after the whole-tree gate:

```sh
docker compose build app
docker compose up -d --wait app
python3 scripts/smoke.py http://127.0.0.1:5317
docker compose restart app
docker compose up -d --wait app
python3 scripts/smoke.py http://127.0.0.1:5317 --verify-persistence
docker compose down
```

Run this in an isolated verification Workspace: the smoke script creates one
named Task and verifies it survives a process restart. The health endpoint must
name the binary and the script must exercise all five product pages. Compose's
persistent Workspace volume survives `down`; retain or explicitly manage only
your own verification volume. Production account and model calls require their
own live evidence; ordinary CI uses an explicit mock posture.
