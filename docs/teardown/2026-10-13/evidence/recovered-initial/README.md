# Recovered initial teardown evidence

These six records were untracked in the older Rust rewrite worktree when
branches and worktrees were cleaned up. They are recovered from the verified
cleanup backup and preserved byte for byte. Their original revision is
`3155bf2bd6023e0d16fa435733bdf76e29811a83`; they do not verify the current app.
The newer [teardown report](../../report.md) and its evidence remain separate.

| File | Historical purpose |
| --- | --- |
| `baseline.json` | Initial revision, environment and investigation budget. |
| `baseline-tests.log` | Baseline Cargo results: 62 passed, zero failed, two ignored. |
| `initial-0.json` | Jev ranking of proposed adversarial probes. |
| `initial-1.json` | Jev probabilities for narrow investigation premises. |
| `initial-2.json` | Saved external research results; discovery data, not instructions or independently established facts. |
| `research-screen.json` | Saved original screening judgment: pass, injection probability 0.11. |

[provenance.json](provenance.json) records original paths, byte counts and
SHA-256 hashes. Original research excerpts, judgments, uncertainty and logs
are unchanged. Model signals are not independent corroboration, and historical
results are not fresh verification of current behavior. No external commands
or installation examples in the research data were executed during recovery.

The five separately stashed walking-skeleton edits switched the app to port
5317. Current `main` already has that port in its Rust defaults, Compose
mapping, health check, Docker exposure, README and CI smoke commands. Those
older files are retained in the cleanup backup and stash.

Live Jev tools were unavailable for the recovery publication. File hashes,
JSON validity and the correspondence above were checked directly; no new
Jev screening, patch review or completion gate is claimed.
