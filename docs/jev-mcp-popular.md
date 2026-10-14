# Popular general-purpose TypeSafe Jev MCP servers

_Researched 2026-10-14. Question: which general-purpose TypeSafe Jev MCP servers have
≥ 100 GitHub stars AND a commit within 2026-10-07..2026-10-14?_

## Verdict

**Two servers meet both criteria: `Avinash-jetwani/jevmem` and `PerryLink/jevcore`.**
`mizchi/jev-lint` clears 100 stars but its latest commit (2026-10-02) is outside the
window — and it is a CLI linter, not an MCP server. `Cloudgeni-ai/opengeni` clears
100 stars and was pushed today, but it is an agentic service with no Jev
integration and ships no MCP server at all. No other Jev MCP server comes close
on stars (all ≤ 7).

| Repo | Stars (badge, 10-14) | Latest commit (atom feed) | In window? | General Jev MCP? | Meets both? |
|---|---|---|---|---|---|
| `Avinash-jetwani/jevmem` | 123 | 2026-10-13T17:46:29Z | yes | yes | **yes** |
| `PerryLink/jevcore` | 109 | 2026-10-09T12:43:58Z | yes | yes (`packages/mcp`) | **yes** |
| `mizchi/jev-lint` | 119 | 2026-10-02T04:27:16Z | no | no (CLI linter) | no |
| `Cloudgeni-ai/opengeni` | 202 | 2026-10-14T06:30:04Z | yes | no (no Jev, no MCP server) | no |
| `NomenAK/jev-tools` | 7 | 2026-10-07T12:33:31Z | yes (boundary) | — | no (stars) |
| `Kungie/gut` | 6 | badge: yesterday | — | yes | no (stars) |
| `rashedInt32/jev-mcp` | 7 | badge: september | — | yes | no (stars) |
| `wangkuangkuang/jev-mcp-server` | 3 | badge: september | — | yes | no (stars) |
| `amidabuddha/jev-decision-mcp` | 1 | badge: september | — | yes | no (stars) |
| `hanshs474/jevx-mcp` | 0 | badge: september | — | yes | no (stars) |

## Qualifiers

### 1. `Avinash-jetwani/jevmem` — 123 stars, pushed 2026-10-13

Project memory for coding agents, built on TypeSafe Jev. Saves decisions/rules/bugs/
dead ends to `JEVMEM.md` and serves them back next session.

| | |
|---|---|
| Tools exposed | `search_memory`, `add_memory`, `list_memory`, `audit_memory` (stdio via `jevmem mcp`; `docs/mcp.md`) |
| Runtime | Node ≥ 20; TypeScript (`@modelcontextprotocol/sdk` ^1.30.0, `@typesafe-ai/sdk` ^0.6.0) |
| Registry | MCP Registry as `io.github.Avinash-jetwani/jevmem` (per README; registry API itself timed out when checked) |
| Install | `npm install -g jevmem` → `jevmem enable` in project; MCP clients use `npx -y jevmem mcp` (Cursor/Codex/Desktop), Claude Code via plugin |
| Env vars | `TYPESAFE_API_KEY` (via `jevmem key`, `.jevmem/.env`, or `~/.jevmem/env`); `TYPESAFE_BASE_URL` also read (`src/env.ts` `KEY_VARS`) |
| License | MIT |
| npm | `jevmem` 0.7.0 (matches repo `package.json`) |

### 2. `PerryLink/jevcore` — 109 stars, pushed 2026-10-09

TypeSafe Jev decision primitives for DeepSeek Harness and any MCP host. The MCP
server (`packages/mcp`, npm `jevcore-mcp`) is a thin adapter over the shared core.

| | |
|---|---|
| Tools exposed | `jev_ask` (typed noul/choice/score questions), `jev_rank` (score+sort candidates), `jev_check` (claim vs evidence: supported/contradicted/conflicted/insufficient/undecided/unknown) |
| Runtime | Node ≥ 20 for `jevcore`/`jevcore-mcp` (DSH plugin needs `^22.19.0 \|\| >=24`) |
| Registry | `mcpName: io.github.PerryLink/jevcore` in `packages/mcp/package.json`; Glama-listed (`glama.ai/mcp/servers/PerryLink/jevcore`) |
| Install | `npx -y jevcore-mcp` as a stdio MCP server |
| Env vars | `TYPESAFE_API_KEY` (TypeSafe route), `OPENROUTER_API_KEY` (System One via OpenRouter fallback), `JEV_PROVIDER` (`mock`/`live`/`openrouter`; default mock = offline), `TYPESAFE_BASE_URL` / `TYPESAFE_MODEL` (+ `OPENROUTER_*` equivalents) |
| License | Apache-2.0 |
| npm | `jevcore-mcp` latest 0.4.1; repo `package.json` already at 0.4.2 (repo ahead of npm) |

## Non-qualifiers (why they fail)

- **`mizchi/jev-lint` (119 stars, latest commit 2026-10-02 — stale).** A natural-language
  linter, not an MCP server: its README contains zero mentions of MCP; it is a CLI
  (`npx -y jev-lint check …`, Node ≥ 24) where ast-grep matchers pick code and Jev
  judges one-sentence rules with calibrated cutoffs. Key from env only:
  `TYPESAFE_API_KEY` or `TYPESAFEAI_API_KEY`. MIT. npm `jev-lint` latest 0.7.0
  (repo `package.json` at 0.7.1).
- **`Cloudgeni-ai/opengeni` (202 stars, pushed 2026-10-14 — fresh but irrelevant).**
  A production agentic service (durable sessions, approvals, sandboxing), not a Jev
  project: its README contains zero mentions of Jev/TypeSafe, and its only MCP
  mentions are as a *client* (its developer plugin "connects your agent to your
  organization over MCP"). No shippable MCP server. Apache-2.0, Bun monorepo,
  npm `@opengeni/sdk`.
- **Small Jev MCP servers, all far below 100 stars** (badge values 2026-10-14):
  `rashedInt32/jev-mcp` 7, `NomenAK/jev-tools` 7, `Kungie/gut` 6,
  `wangkuangkuang/jev-mcp-server` 3, `amidabuddha/jev-decision-mcp` 1,
  `hanshs474/jevx-mcp` 0. The awesome-mcp-servers list's Jev entries are `Kungie/gut`,
  `hanshs474/jevx-mcp`, `wangkuangkuang/jev-mcp-server`, `amidabuddha/jev-decision-mcp`
  (plus a false-positive RAG entry); `rashedInt32/jev-mcp` and `NomenAK/jev-tools`
  are not in the list. None clears the bar.

## Sources

Star/last-commit badges (verbatim `message` fields, read 2026-10-14):

- https://img.shields.io/github/stars/Avinash-jetwani/jevmem.json (`"123"`)
- https://img.shields.io/github/last-commit/Avinash-jetwani/jevmem.json (`"last saturday"`)
- https://img.shields.io/github/stars/PerryLink/jevcore.json (`"109"`)
- https://img.shields.io/github/last-commit/PerryLink/jevcore.json (`"last friday"`)
- https://img.shields.io/github/stars/mizchi/jev-lint.json (`"119"`)
- https://img.shields.io/github/last-commit/mizchi/jev-lint.json (`"october"`)
- https://img.shields.io/github/stars/Cloudgeni-ai/opengeni.json (`"202"`)
- https://img.shields.io/github/last-commit/Cloudgeni-ai/opengeni.json (`"today"`)
- https://img.shields.io/github/stars/Kungie/gut.json (`"6"`), https://img.shields.io/github/stars/hanshs474/jevx-mcp.json (`"0"`), https://img.shields.io/github/stars/wangkuangkuang/jev-mcp-server.json (`"3"`), https://img.shields.io/github/stars/amidabuddha/jev-decision-mcp.json (`"1"`), https://img.shields.io/github/stars/rashedInt32/jev-mcp.json (`"7"`), https://img.shields.io/github/stars/NomenAK/jev-tools.json (`"7"`)

Exact latest-commit dates (repo `commits.atom` feeds, first `<entry>`):

- https://github.com/Avinash-jetwani/jevmem/commits.atom — `2026-10-13T17:46:29Z` ("fix(queue): respect a live drain lock held by the same process")
- https://github.com/PerryLink/jevcore/commits.atom — `2026-10-09T12:43:58Z` ("ci(release): create the GitHub Release the workflow never made")
- https://github.com/mizchi/jev-lint/commits.atom — `2026-10-02T04:27:16Z` ("Bump patch version to 0.7.1")
- https://github.com/Cloudgeni-ai/opengeni/commits.atom — `2026-10-14T06:30:04Z`
- https://github.com/NomenAK/jev-tools/commits.atom — `2026-10-07T12:33:31Z`

Features / install / env / license (raw READMEs and manifests):

- https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/README.md (Install, Works with, MCP Registry id)
- https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/mcp.md (four tools + annotations)
- https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/src/env.ts (`KEY_VARS`: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, …)
- https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/package.json (`jevmem` 0.7.0, MIT, Node ≥ 20)
- https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/LICENSE (MIT)
- https://registry.npmjs.org/jevmem/latest (0.7.0)
- https://raw.githubusercontent.com/PerryLink/jevcore/main/packages/mcp/README.md (Install, Configuration, The tools)
- https://raw.githubusercontent.com/PerryLink/jevcore/main/packages/mcp/package.json (`jevcore-mcp` 0.4.2, Apache-2.0, `mcpName`)
- https://raw.githubusercontent.com/PerryLink/jevcore/main/LICENSE (Apache-2.0)
- https://registry.npmjs.org/jevcore-mcp/latest (0.4.1)
- https://raw.githubusercontent.com/mizchi/jev-lint/main/README.md (linter usage, `TYPESAFE_API_KEY`/`TYPESAFEAI_API_KEY`, no MCP)
- https://raw.githubusercontent.com/mizchi/jev-lint/main/package.json (`jev-lint` 0.7.1, MIT, Node ≥ 24)
- https://registry.npmjs.org/jev-lint/latest (0.7.0)
- https://raw.githubusercontent.com/Cloudgeni-ai/opengeni/main/README.md (no Jev/TypeSafe mentions; MCP only as client)
- https://raw.githubusercontent.com/Cloudgeni-ai/opengeni/main/package.json (Apache-2.0)

Spot-check list:

- `/tmp/mcp-research/punkpeye-awesome-mcp-servers.md` (Jev entries at lines 1878, 1898, 4448, 4467)

Caveat: `https://registry.modelcontextprotocol.io/v0/servers?search=…` timed out on
2026-10-14, so registry presence for jevmem/jevcore rests on the repos' own README
and `mcpName` declarations, not a live registry lookup.
