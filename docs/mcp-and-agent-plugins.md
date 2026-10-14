# MCP servers & agent plugins worth installing (global picks)

_Researched 2026-10-14. Question: for **global** use — not tuned to this repo — which MCP
servers and agent plugins are healthy and popular, and which are strong but under-discovered?
Repo commit: `4e304e9`._

**Companion document:** [`docs/omp-jev-integrations.md`](./omp-jev-integrations.md) answers the
narrower question "are there omp↔Jev integrations?" (yes: the `judge` role, `judge_batch`, the
`omp-typesafe` extension, two Jev MCP servers). This file is the broad catalog; that one is the
TypeSafe-specific deep dive. They deliberately overlap only where a Jev package is also a
global pick.

---

## How to read the numbers

Every popularity and health figure below was **measured**, and the measurement is named.
There is no unlabelled "popular" or "actively maintained".

| Marker | Means | How it was obtained |
| --- | --- | --- |
| `stars 33,598 (33.6k HTML)` | exact page-payload count | embedded `"stargazerCount"` JSON in the repo HTML |
| `stars 298,780 (GitHub API)` | exact count | one `api.github.com/repos/<repo>` call (budgeted) |
| `last commit: yesterday (shields.io)` | recency | `img.shields.io/github/last-commit/<repo>.json` |
| `npm 614,158 dl/mo` | monthly downloads | `api.npmjs.org/downloads/point/last-month/<pkg>` |
| `PyPI 1.2.0, 72 releases` | package activity | `pypi.org/pypi/<pkg>/json` |
| `[SECONDARY]` | not grounded in the owner's own source | — |

**How stars were measured (correction recorded mid-research):** the legacy
`repo-stars-counter-star` badge markup is absent from fetched pages (verified: 0 matches — that
recipe is dead). But the page's embedded JSON payload carries `"stargazerCount"`, which is exact
and quota-free (verified against the GitHub API on four repos: 298,781; 278,737; 74,594; 33,598 —
all match). Figures marked "HTML" use that payload. Figures marked "shields.io" use
`img.shields.io/github/stars/<repo>.json` and are rounded (`"91k"`, `"last sunday"`); reproduced
as-is, never converted into false precision. When a row's marker and this box disagree, the row wins.

**Health bar.** A row earns a "Pick" only if it clears most of: not archived, a commit or release
inside ~60 days, a license file that actually resolves, and an install that resolves from a
published package rather than "clone and run". Rows failing the bar are kept, but only in
*Rejected / risks* with the specific failure named.

---

## Install surfaces (omp)

The picks below are host-agnostic; this is how each channel lands in **omp** specifically.

| Kind | Command | Notes |
| --- | --- | --- |
| MCP server | add to `.omp/mcp.json` (project) or `~/.omp/agent/mcp.json` (user) | `mcpServers` map; `command`+`args` for stdio, `type:"http"`+`url` for remote. See `omp://mcp-config.md`. |
| npm extension | `omp plugin install npm:<pkg>` (alias `omp install npm:<pkg>`) | verified: `omp install npm:@plannotator/pi-extension` |
| GitHub extension/plugin | `omp plugin install github:<owner>/<repo>[#ref]` | verified dry-run: `omp plugin install github:siddicky/omp-typesafe` |
| Marketplace catalog | `omp plugin marketplace add <owner>/<repo>` → `omp plugin install <name>@<marketplace>` | Claude-Code-compatible catalogs load from `.claude-plugin/marketplace.json`. See `omp://marketplace.md`. |
| Skill | `omp skill install <spec>` | **caveat:** omp's own Skillshare registry (`skills.omp.sh`) returned **0 hits** for `pdf` and `review` in testing, so prefer `npx skills add …` or a GitHub plugin until that registry fills. |
| Verify what loaded | `omp plugin list`, `omp mcp list`, `omp skill list` | restart (not just `/reload-plugins`) for newly added non-MCP tools/extension modules |

### Two traps that bite "global" installs

1. **A configured browser MCP server can be dropped silently.** When `browser.enabled` is true
   (the default) *and* Eval is active, omp discards browser-automation MCP servers at config load
   — matching names `playwright`, `puppeteer`, `browser`, `browser-use`, `browserbase`, or
   recognized packages (see `omp://mcp-config.md`). To use Playwright MCP instead of the built-in
   browser tool, set `browser.enabled: false`. Entries in the two primary config files still
   appear in `/mcp list` as `not connected`; entries from other sources vanish without a warning.
2. **Foreign (Claude/Codex) skills are opt-in at user level.** `skills.enableClaudeUser` defaults
   **false** (this machine: false, while `enableAgentsUser` is true), and the same pattern applies
   to foreign *providers* via `enabledProviders`. Installing a Claude-only skill globally without
   setting the toggle makes it invisible. Project-level sources load regardless.

---

## 1. Agent plugins, skills & marketplaces

The agent-plugin ecosystem has two centers of gravity: Anthropic's official directory, and a
handful of very large cross-harness catalogs. The star counts here are enormous and real —
verified two ways.

| Name | What it is | Popularity (measured) | Health | Install |
| --- | --- | --- | --- | --- |
| **Claude Code Plugins Directory** (official) | Anthropic's curated catalog — **315 plugins** (123 development, 69 productivity, 39 database, 22 monitoring, 18 security) | 38k stars; commits daily | `.claude-plugin/marketplace.json` parsed; Apache-2.0 | `/plugin install <name>@claude-plugins-official` |
| **Superpowers** | Full SDLC methodology: brainstorm → spec → plan → subagent dev → TDD; skills auto-trigger | **298,780 stars (GitHub API)**, 26,710 forks; pushed 2026-10-10 | MIT; not archived; ships *inside* the official directory | `/plugin install superpowers@claude-plugins-official` |
| **Anthropic Agent Skills** | Reference implementation of `SKILL.md` + xlsx/docx/pptx/pdf skills | 181k stars | **No LICENSE file (root 404)** — redistribution unclear | `/plugin marketplace add anthropics/skills` |
| **`skills` CLI** (vercel-labs) | Cross-harness skills installer for **71 agents** incl. claude-code, codex, cursor, gemini-cli, opencode, goose, amp, **pi** | **25,093,274 npm dl/mo**; 35k stars | MIT (`LICENSE` resolves); 59 commits/mo | `npx skills add <owner>/<repo>` |
| **wshobson/agents** | 94 plugins / 202 agents / 184 skills / 105 commands, Markdown source re-generated per harness | 41k stars; 28 commits/mo | MIT | `/plugin marketplace add wshobson/agents` |
| **GitHub Spec Kit** | Spec-driven development; `/speckit-*` skills, per-agent integrations | 141k stars; **231 commits/mo** | MIT; PyPI `specify-cli` 1.2.0 with **72 releases** | `uv tool install specify-cli` → `specify init <p> --integration <agent>` |
| **BMAD-METHOD** | Agile-agent methodology, modular (`bmod-*`) | 54k stars; 85 commits/mo | MIT; needs Python 3.10+/uv; **v7 is alpha** | `npx bmad-method install` (stable) |
| **ECC (Everything Claude Code)** | "Agent harness OS": skills/agents/commands/hooks for Claude, Codex, Cursor, Gemini, OpenCode | **278,737 stars (GitHub API)**, 41,515 forks; pushed 2026-10-12 | MIT; npm `ecc-universal` 52,823 dl/mo | `npx ecc-universal@2.2.3 install --guided` |
| **Ruflo** (was claude-flow) | Swarm orchestration, 60+ agents, RAG memory | **74,594 stars (GitHub API)**; npm `ruflo` 243,767 dl/mo | MIT; pushed 2026-10-13; **repo was renamed** — old slug 301-redirects | `npx ruflo@latest init wizard` |
| **Compound Engineering** | Turns past mistakes into reusable lessons; Claude/Codex/Cursor/Grok Bot | 26k stars | MIT; marketplace.json parsed | `/plugin marketplace add EveryInc/compound-engineering-plugin` |
| **VoltAgent subagents** | Categorized subagent pack (language, infra, meta-orchestration) | 26k stars | MIT; 0 open issues | `claude plugin marketplace add VoltAgent/awesome-claude-code-subagents` |
| **planning-with-files** | File-based planning skill; ships `.agents/skills/` so Zed/Amp/Warp/Devin discover it by plain clone | 27k stars; 117 commits/mo | MIT (default branch `master`) | `npx skills add OthmanAdi/planning-with-files -g` |
| **pi-subagents** | Subagent delegation + scripted multi-agent workflows; loads in omp too | **614,158 npm dl/mo**; 146 versions | MIT; 0.78.0 (2026-10-13) | `pi install npm:pi-subagents` |
| **Plannotator** | Interactive plan review with annotations | **133,196 npm dl/mo**; 9.4k stars | Apache-2.0; 0.28.19 | `omp plugin install npm:@plannotator/pi-extension` |
| **claude-code-tools** | Session continuity/anti-compaction, Rust/Tantivy session search, safety hooks | 2k stars; 31 commits/mo | MIT | `npx skills add pchalasani/claude-code-tools` |
| **claude-codex-settings** | Curated skills/commands/hooks/subagents per provider | 1.2k stars; 14 commits/mo | Apache-2.0 | `claude plugin marketplace add fcakyon/claude-codex-settings` |

### Rejected — abandoned despite large followings

Star counts lie about maintenance. Every row below was **measured**, and failed:

- **SuperClaude_Framework** (24k stars, MIT, not archived) — last **release March**, issue badge
  `invalid`, 2 commits/mo. Maintenance-only decline.
- **buildermethods/agent-os** (5,502 stars) — last release **January**, **1 commit/month**.
- **disler/claude-code-hooks-mastery** (3,940) — pushed 2026-03-04, **0 commits/mo**, **no LICENSE**.
- **NeoLabHQ/context-engineering-kit** (1.8k) — last release August, 0 commits/mo; GPL-3.0.
- **vercel-labs/agent-skills** (32k) — last commit August, 0 commits/mo; use as *content* via
  `npx skills add`, never as a maintained dependency.
- **hesreallyhim/awesome-claude-code** — **CC BY-NC-ND 4.0** (verified from the repo `LICENSE`):
  non-commercial, **no derivatives**. Cannot be vendored or excerpted into another catalog;
  read-only reference.

---

## 2. MCP infrastructure — bridges, gateways, registries, security

**Read this first:** the MCP spec moved on. Current revision is **2026-07-28**; it **removed
protocol sessions and `Mcp-Session-Id`** from Streamable HTTP and reclassified the old
**HTTP+SSE transport as Deprecated** (SEP-2596, "Migrate to Streamable HTTP"). Verified verbatim
at `modelcontextprotocol.io/specification/2026-07-28/changelog`.

**omp is a 2025-11-25-era client.** The installed 18.10.4 binary negotiates protocol `2025-11-25`
and implements stdio, Streamable HTTP (`Mcp-Session-Id` + `Last-Event-ID` resumption), and a
`LegacySseTransport` labelled `2024-11-05`. It does **not** speak 2026-07-28's stateless
`server/discover` flow. Practically: a 2026-07-28-only gateway will not work with omp today.

| Name | Role | Popularity (measured) | Spec posture | Install |
| --- | --- | --- | --- | --- |
| **sparfenyuk/mcp-proxy** | stdio ↔ streamable-HTTP bridge | 2.8k stars; PyPI 0.13.0 (2026-10-10) | `--transport=streamablehttp` is the default | `uv tool install mcp-proxy` |
| **Supergateway** | 4-way transport bridge + aggregator | 2.9k stars; npm 4.1.0 (2026-10-13) | **Only bridge seen that explicitly implements 2026-07-28** stateless semantics (`--protocolVersion`, `--stateful`) | `npx -y supergateway …` |
| **1MCP agent** | Aggregator with lazy tool loading | 516 stars; npm 0.39.2 (2026-10-14) | Streamable HTTP; OAuth-capable | `npm i -g @1mcp/agent` |
| **MCP Inspector** (official) | Reference debug client (web/TUI/CLI) | **11k stars**; npm 2.11.0 | Connects stdio/HTTP/SSE | `npx @modelcontextprotocol/inspector` |
| **Snyk Agent Scan** (was Invariant `mcp-scan`) | Scans configs/servers for prompt injection, exfiltration, malware | 3.1k stars; PyPI 0.6.8 | static + dynamic | `uvx snyk-agent-scan@latest` |
| **MCPProxy** (mcpproxy-go) | Local proxy with **quarantine defaults** + BM25 tool filtering + SARIF scanners | 390 stars | Streamable HTTP | `brew install smart-mcp-proxy/mcpproxy/mcpproxy` |
| **Official MCP Registry** | Vendor-neutral discovery | 7.4k stars | Serves `streamable-http` remotes; schema `2025-12-11` | `GET https://registry.modelcontextprotocol.io/v0/servers?search=&limit=&cursor=` |
| **Docker MCP Gateway** | Container-isolated catalog ("300+ tools") | 1.6k stars; ships with Docker Desktop 4.59+ | `docker mcp gateway run --transport …` | Docker CLI plugin |
| **IBM ContextForge** | Full registry+proxy+federation with OpenTelemetry | 4.6k stars; PyPI 1.0.11 | multi-protocol, negotiates version | `uvx --from mcp-contextforge-gateway mcpgateway` |
| **ToolHive** (stacklok) | Container-based gateway + K8s operator | 2.3k stars; v0.53.0 | **spec revision unverified** | `brew install thv` |
| **omp auth-gateway** *(native)* | Credential vault + forward proxy; exposes `/v1/systemone` among others | n/a (local, v18.10.4) | omp-native | `omp auth-broker serve` → `omp auth-gateway serve` |

### Rejected / traps

- **mcp-get** — README says "⚠️ DEPRECATED"; archived; last commit 2024-11-26.
- **mcp-shield** — no release in ~18 months (2025-04-26). Superseded by Snyk Agent Scan.
- **mcp-guardian** (2025-04-10), **mcp-installer** (2024-11-26), **mcp-hub** (2025-08-22),
  **mcpo** (last release 2026-02-27, ~8 months) — all functionally unmaintained.
- **microsoft/mcp-gateway** — technically the most current (2026-07-28 only) but **not published
  to any package registry** and deliberately drops 2025-era clients. Unusable by omp today.
- **Name traps**: `mcp-scan` on PyPI (0.4.3) is a *different, older* project — install
  `snyk-agent-scan`. `unla-ai/unla` moved to `amoylab/unla`. `cyberark/mcp-proxy` 404s.
- **SSE-only servers as a category** — formally Deprecated; front them with a Streamable-HTTP
  bridge rather than wiring them in directly.

---

## 3. Hidden gems (100–2,500 stars, pushed ≤60 days, license + tests/CI)

Independently spot-checked: every repo below exists, and its star count and published version
reproduce from shields.io / PyPI / npm.

| Gem | The non-obvious thing it does | Stars | Last commit | Install |
| --- | --- | --- | --- | --- |
| **knowsuchagency/mcp2cli** | Never puts tool schemas in context — you invoke MCP tools as shell verbs | 2.4k | 2026-10-12 | `uv tool install mcp2cli` (PyPI 3.8.0) |
| **apify/mcpc** | Full-spec MCP client as one `Bash()` call; the only CLI with a **conformance** test workflow | 1k | 2026-10-13 | `npm i -g @apify/mcpc` (0.7.0) |
| **redhat-et/ripwire** | The *write* side: `--edit-check` returns blast radius + tests reaching the edit | 2.4k | 2026-10-13 | install script (Red Hat) |
| **agent-sh/agnix** | Lints the agent config itself — 455 rules over CLAUDE.md, SKILL.md, hooks, MCP JSON | 450 | 2026-10-12 | `npx agnix .` (npm 0.57.0) |
| **arabold/docs-mcp-server** | Self-hosted, version-pinned docs index from web/GitHub/npm/PyPI/local/zip | 1.8k | 2026-10-11 | `npx @arabold/docs-mcp-server@latest` (3.2.1) |
| **2akouwu/reverify** | Inverts trust: the model *proposes*, a deterministic tool returns VERIFIED/REFUTED | 1.3k | 2026-09-07 | `pip install reverify` (0.10.0) |
| **vshulcz/deja-vu** | Indexes session history **already on disk** for 40+ agents; ships its benchmark drivers | 1.2k | 2026-10-14 | `npm @vshulcz/deja-vu` (0.22.1) |
| **scaccogatto/okf-skills** | Only Open Knowledge Format toolchain for agents (trust/provenance/staleness frontmatter) | 413 | 2026-10-13 | `/plugin marketplace add scaccogatto/okf-skills` |
| **infragate/capa** | `capabilities.yaml` + lockfile writes native config into **35+ agents**, then acts as a gateway | 724 | 2026-10-12 | `curl -LsSf https://capa.sh/install.sh` |
| **cisco-ai-defense/mcp-scanner** | Supply-chain scan of *other* MCP servers (YARA + LLM + pip-audit + VirusTotal) | 1.1k | 2026-10-07 | `uv tool install cisco-ai-mcp-scanner` (4.8.6) |
| **plmbr/notebook-intelligence** | An MCP-capable agent *inside* JupyterLab — filed as a Jupyter extension, not an MCP server | 347 | 2026-10-06 | `pip install notebook-intelligence` (GPL-3.0) |
| **marc-shade/world-intel-mcp** | 139 tools over free public APIs (ADS-B, ACLED, SEC EDGAR, USGS) | 941 | 2026-10-12 | clone + `pip install -e .` (no PyPI) |
| **nicobailon/pi-mcp-adapter** | Replaces hundreds of tool defs with one ~200-token proxy; servers start on first call, idle-stop | 1.6k | 2026-10-13 | Pi extension |
| **mattt/iMCP** | Bridges macOS Messages/Contacts/Calendar/Maps/Reminders to MCP | 1.7k | 2026-10-14 | `brew install --cask mattt/tap/iMCP` (macOS only) |

**Gems that failed the bar (kept for the idea):** `Oldcircle/geo-sleuth` (2.4k, novel geometry-based
photo geolocation, but **no CI workflows and no tests**); `fastcrw/crw` (AGPL-3.0 + npm name
collision); `Mibayy/token-savior` (kept, but its headline `-80%` claim is self-reported with a
withdrawn re-measurement).

### Scale signals for the directory layer

`registry.modelcontextprotocol.io` is the spec-owned, vendor-neutral registry (paginate on
`metadata.nextCursor`); Smithery reports **20,063 servers**; Glama's own page title reads
**97,619**; PulseMCP advertises **21,940+ updated daily**; Docker's catalog advertises **300+
tools**. Treat these as *directory counts*, not health signals.

---
## 4. Data, search, memory & productivity

| Name | Does | Popularity (measured) | Install | Auth |
| --- | --- | --- | --- | --- |
| **MCP-SearXNG** | Metasearch over your own SearXNG + SSRF-guarded fetch | 1.3k stars; npm 2.6.0 (published 2026-10-13) | `npx -y mcp-searxng` | **keyless** (you run SearXNG) |
| **open-webSearch** | Keyless multi-engine search + page fetch | 1.9k stars; npm 2.2.0 | `npx open-websearch@latest` | **keyless** |
| **Crawl4AI** | LLM-ready crawler/scraper; `/scrape /extract /search /answer` | 85k stars; PyPI 0.9.4 | `pip install -U crawl4ai` or hosted `/mcp` | self-host keyless; hosted free tier 2,000 credits |
| **MarkItDown** (microsoft) | PDF/DOCX/PPTX/XLSX/HTML/audio → Markdown | 190k stars; PyPI `markitdown-mcp` **0.0.1a7 (still alpha)** | `pip install markitdown-mcp` | none |
| **server-memory** (reference) | Knowledge-graph persistent memory | 91k stars (repo) | `npx @modelcontextprotocol/server-memory` | none; README says "educational, not production-hardened" |
| **basic-memory** | Local-first memory as Markdown + wikilink graph | 4.2k stars; PyPI 0.23.2 | `uvx --prerelease=allow basic-memory mcp` | local keyless; optional cloud $15/mo; **AGPL-3.0** |
| **mcp-memory-service** | Semantic memory; embeddings computed **locally via ONNX** | 2k stars; PyPI 12.0.0 (2026-10-13) | `pip install mcp-memory-service` | none |
| **Cognee** | Graph/semantic memory layer over your data | 32k stars; PyPI 1.6.4 | `uv sync` in `cognee-mcp/` | `LLM_API_KEY` for graph build |
| **MCPVault** (mcp-obsidian) | Direct read/search/edit of Obsidian vaults | 1.7k stars; npm 0.16.0 | `npx @bitbonsai/mcpvault@latest <vault>` | none (local FS) |
| **mcp-alchemy** | One SQLAlchemy server across Postgres/MySQL/SQLite/Oracle/SQL Server | 420 stars | `uvx mcp-alchemy` | `DB_URL`; read-only flag |
| **mcp-server-mysql** (benborla) | MySQL schema inspection + guarded queries | 2.2k stars; npm 2.0.9 | `npx @benborla29/mcp-server-mysql` | DB creds |
| **postgres-mcp** (crystaldba) | Postgres index tuning, health, safe SQL | 3.4k stars | `uv pip install postgres-mcp` | DB creds; **packaged release stale (0.3.0, 2025-05-16)** |
| **slack-mcp-server** | Read Slack DMs/channels/threads — **stealth mode needs no OAuth app** | 1.9k stars | Go build / Docker | stealth keyless, or OAuth token |
| **Workspace MCP** | 120+ tools: Gmail/Calendar/Drive/Docs/Sheets/Slides/Chat | 3.3k stars | `uvx workspace-mcp --tool-tier core` | OAuth 2.1; **works on free Google accounts** |
| **mcp-notion-server** (suekou) | Read/write Notion pages & databases | 920 stars; npm 2.0.2 | `npx @suekou/mcp-notion-server` | free Notion token |
| **telegram-mcp** | Telegram dialogs/messages/search + **local** whisper transcription | 1.8k stars; v3.2.80 | **clone + `uv run`** — never `uvx` | free API ID/hash |
| **Filestash** | MCP gateway over S3/SFTP/FTP/SMB/WebDAV/Git/Drive | 15k stars | `docker run` | per-backend creds; **AGPL-3.0** |

### Rejected / risks

- **`mem0ai/mem0-mcp`** — **archived** (verified: `archived: true`, last push 2026-03-24).
- **`chroma-core/chroma-mcp`** (dormant, 2 commits since v0.2.6), **`weaviate/mcp-server-weaviate`**
  (no license, dormant), **`zilliztech/mcp-server-milvus`** (no releases) — the vector-store category
  is thin on healthy community options.
- **`benborla29/mcp-server-mysql`** — **404**; the real repo is `benborla/mcp-server-mysql` (verified).
  The npm *package* is still `@benborla29/mcp-server-mysql`.
- **Bio/analytics**: no healthy community Metabase server exists (`hyeongjun-dev`, `imlewc` variants
  have no license and April-2025 commits) — recorded rather than padded. Closest substitutes:
  `pab1it0/prometheus-mcp-server` (518), `julien040/anyquery` (1.8k, AGPL), `mcp-server-bigquery`.
- **`kagi-ken-mcp`** — paid Kagi only, last commit February, no CI.
- **Keyless vector memory** is scarce: `local_faiss_mcp` (36) and `gnosis-mcp` (29) are the only
  non-vendor options found.

**Free tiers worth knowing:** Tavily 1,000/mo · Brave $5/mo credits · Exa $1,000 trial · Crawl4AI
hosted 2,000 credits · Firecrawl hosted keyless.

---

---

## 5. Vendor-official MCP servers

Measurement correction worth stating plainly: exact star counts **are** recoverable from the
repo page without GitHub API quota — `"stargazerCount"` sits in the page's embedded JSON payload.
My earlier "React shell" verdict only covered the legacy `*-counter-star` badge markup. The
figures below use the exact HTML payload unless marked shields.io.

| Name | Repo / URL | Stars (how) | License | Auth | Install |
| --- | --- | --- | --- | --- | --- |
| **GitHub** | `github/github-mcp-server` | 33,598 (33.6k HTML) | MIT | PAT | remote `https://api.githubcopilot.com/mcp/` · Docker `ghcr.io/github/github-mcp-server` |
| **Chrome DevTools** | `ChromeDevTools/chrome-devtools-mcp` | 53.5k | Apache-2.0 | none | `npx -y chrome-devtools-mcp@latest` |
| **Playwright** | `microsoft/playwright-mcp` | 38.1k | Apache-2.0 | none | `npx @playwright/mcp@latest` |
| **Context7** | `upstash/context7` | 63.0k | MIT | none (key lifts limits) | `npx -y @upstash/context7-mcp` · remote `https://mcp.context7.com/mcp` |
| **Supabase** | `supabase/mcp` (moved from community org — verified live) | 2.9k | Apache-2.0 | PAT/OAuth | `npx -y @supabase/mcp-server-supabase@latest` · remote with `read_only=true` |
| **Neon** | `neondatabase-labs/mcp-server-neon` | 651 | MIT | API key/OAuth | prefer the **remote** endpoint; the local npm package is stale (0.6.5, Mar) |
| **Grafana** | `grafana/mcp-grafana` | 3.6k; 4.1M Docker pulls | Apache-2.0 | service-account token | `uvx mcp-grafana` |
| **AWS** | `awslabs/mcp` (60+ servers) | 9.8k | Apache-2.0 | AWS creds/SigV4 | install only the modules you need (`awslabs.aws-documentation-mcp-server@latest`) |
| **Azure** | `microsoft/mcp` (the old `azure/azure-mcp` is **archived**) | 3.8k | MIT | Azure creds | `npx -y @azure/mcp@latest server start` |
| **Google Cloud** | `google/mcp` index → `googleapis/mcp-toolbox` (16.7k: generic DB-to-MCP via `tools.yaml`), `gcloud-mcp`, `cloud-run-mcp` | — | Apache-2.0 | gcloud ADC | per-tool install |
| **MongoDB** | `mongodb-js/mongodb-mcp-server` | 1.1k; 102 releases | Apache-2.0 | connection string | `npx -y mongodb-mcp-server@latest --readOnly` |
| **Redis** | `redis/mcp-redis` | 634 | MIT | URL | `uvx --from redis-mcp-server@latest redis-mcp-server` |
| **ClickHouse** | `ClickHouse/mcp-clickhouse` | 887 | Apache-2.0 | CH creds | `pip install mcp-clickhouse` (chDB local mode too) |
| **Cloudflare** | `cloudflare/mcp-server-cloudflare` | 4.4k | Apache-2.0 | OAuth | remote fleet (`observability`, `containers`, `browser`, `dex`, `casb`) |
| **Stripe** | `stripe/agent-toolkit` | 1.9k | MIT | OAuth | remote `https://mcp.stripe.com`; also the best vendor-run **skills** example |
| **Sentry** | `getsentry/sentry-mcp` | 928 | **FSL-1.1-ALv2 (source-available)** | user token/OAuth | `npx @sentry/mcp-server@latest` · remote `https://mcp.sentry.dev/mcp` |
| **Terraform** | `hashicorp/terraform-mcp-server` | 1.5k; 1.55M Docker pulls | MPL-2.0 | none for Registry reads | `docker run -i --rm hashicorp/terraform-mcp-server` |
| **K8s** | `containers/kubernetes-mcp-server` | 2.2k; cross-published npm **and** PyPI | Apache-2.0 | kubeconfig | `npx -y kubernetes-mcp-server@latest` |
| **Firecrawl** | `firecrawl/firecrawl-mcp-server` | 7.6k | MIT | API key (free tier) | `npx -y firecrawl-mcp` |
| **Brave** | `brave/brave-search-mcp-server` | 1.5k; 102 releases | MIT | API key (free tier) | `npx -y @brave/brave-search-mcp-server` |
| **Tavily / Exa** | `tavily-ai/tavily-mcp` · `exa-labs/exa-mcp-server` | 2.4k · 5.1k | MIT | API key (free tier) | `npx -y tavily-mcp@latest` · remote `https://mcp.exa.ai/mcp` |
| **Kubernetes… (ADO)** | `microsoft/azure-devops-mcp` | 2.1k | MIT | Entra ID/PAT | `npx -y @azure-devops/mcp <org>` |
| **Apollo GraphQL** | `apollographql/apollo-mcp-server` | 314; 72 releases | MIT | GraphOS creds | `npx -y apollo-mcp-server` |
| **GitLab** | built into the product (19.5+, no standalone repo) | — | — | OAuth DCR | per-instance endpoint |
| **Linear / Slack / Notion / Figma / Atlassian / Vercel** | **hosted-only**: `mcp.linear.app/mcp`, `mcp.slack.com/mcp`, Notion MCP docs, `mcp.figma.com/mcp`, `mcp.atlassian.com/v2/mcp`, `mcp.vercel.com` | — | — | OAuth | remote URLs; no server repo to clone |

**Traps the slice proved, each verified independently:**
- `linear/linear` is an SDK monorepo — no MCP package exists (`contents` API); Linear is hosted-only.
- `azure/azure-mcp` **archived** (verified) → use `microsoft/mcp`.
- `googleworkspace/dev-assist` and `developer-mcp` **both archived** → use `gemini-cli-extensions/workspace` endpoints.
- `twilio-labs/mcp` is official but untouched since 2025-07 → risky.
- `databrickslabs/mcp` untouched since 2025-07-09, no published package → avoid for now.
- `oracle/mcp` README says **proof-of-concept, not for production**.
- `dynatrace-oss/dynatrace-mcp` **archived** Aug 2026; `semgrep/mcp` **archived** Oct 2025.
- `PostHog/mcp`, `pagerduty/pagerduty-mcp-server` — deprecated repos; use their hosted endpoints.
- `vercel/mcp-adapter` is a framework, not Vercel's server. `figma/mcp-server-guide` is a guide with
  **no LICENSE file** (verified 404 on main and master). `sonarqube-mcp-server` is source-available,
  not OSI.
- All search API keys stack (Brave/Tavily/Exa free tiers); Postgres itself has **no**
  vendor-official server — the reference one lives in the archived legacy repo.

---

## 6. Dev-tooling & coding-agent MCP servers

| Name | Does | Popularity (measured) | Install |
| --- | --- | --- | --- |
| **Serena** | Semantic code retrieval + LSP-backed symbol edits across 20+ languages | 30k stars; PyPI 2.0.0 (2026-10-13) | `uv tool install serena-agent` |
| **agent-lsp** | Keeps language servers warm across sessions; batch ops (`blast_radius`, speculative edits) | 162 stars; release v0.23.0 | install script + per-language Docker tags |
| **GitMCP** (idosal) | Turns **any** GitHub repo into a docs/code MCP endpoint — no install | 8.5k stars | point client at `https://gitmcp.io/{owner}/{repo}` |
| **sooperset/mcp-atlassian** | Jira + Confluence CRUD/JQL/pages, DC + Cloud | 6k stars; PyPI 0.23.1 | `uvx mcp-atlassian` |
| **tacticlaunch/mcp-linear** | Linear issues/projects/cycles | 147 stars; 41,337 npm dl/wk | `npx -y @tacticlaunch/mcp-linear` |
| **gitlab-mcp** | GitLab REST v4 with `--permission-mode=readonly (also modify, full)` | 2k stars; 140,283 npm dl/wk | `npx -y @zereight/mcp-gitlab@latest` |
| **buildkite-mcp-server** | `compare_builds`: failing vs last passing on the same branch | 55 stars; official; 69 releases | Go binary or hosted remote |
| **cyanheads/git-mcp-server** | 28-tool local git; supersedes stale reference `mcp-server-git` | 241 stars; npm 2.15.3 | `npx @cyanheads/git-mcp-server@latest` |
| **lanbaoshen/mcp-jenkins** | The only *maintained* Jenkins MCP (tested, published) | 154 stars; PyPI 3.6.0 | `uvx mcp-jenkins` |
| **mcp-server-circleci** | Failing-build logs, cause analysis, reruns (first-party vendor org) | 93 stars; 18,899 npm dl/wk | `npx -y @circleci/mcp-server-circleci@latest` |
| **Tiberriver256 Azure DevOps** | The ADO pick that actually publishes and ships | 393 stars; 6,688 npm dl/wk | `npx -y @tiberriver256/mcp-server-azure-devops` |
| **ckreiling/mcp-server-docker** | Local Docker socket: containers/images/logs/exec | 747 stars; PyPI 0.3.0 matches HEAD | `uvx mcp-server-docker` (GPL-3.0 — check policy) |
| **GLips/Figma-Context-MCP** (Framelink) | De-facto Figma handoff server | 16k stars; 91,027 npm dl/wk | `npx figma-developer-mcp --figma-api-key=…` |
| **appium/appium-mcp** | Mobile/desktop UI automation | 498 stars; npm 1.97.1 | `npx -y appium-mcp@latest` |
| **kadykov/mcp-openapi-schema-explorer** | Only OpenAPI server using MCP **Resource Templates** (5 MB specs stay out of context) | 76 stars | npm/published |

**Dead or redundant despite fame:** `QuantGeekDev/docker-mcp` (last commit 2024-12-14 — verified);
`regenrek/deepwiki-mcp` (2025-07-22); `executeautomation/mcp-playwright` (verified via last-commit,
superseded by `microsoft/playwright-mcp`); `snaggle-ai/openapi-mcp-server`; `octocode` is borderline
(50 days idle). `tom28881/mcp-jira-server` is a **404** (verified) — it exists in awesome lists only.
`docker/hub-mcp` has no published artifact — build-from-source only. `gitkraken/gk-cli` is
**all-rights-reserved** (verified LICENSE head). JetBrains' `mcpProxy` is stale since 2025-08;
prefer the indexed plugin `hechtcarmel/jetbrains-index-mcp-plugin` (361 stars, MIT, v5.20.2).
Asana's only npm-published server (`@roychri/mcp-server-asana`) was last touched 2026-04 — thin.

---

## Bottom line — if you install ten things

1. **`Superpowers`** (`/plugin install superpowers@claude-plugins-official`) — the whole SDLC
   methodology, inside Anthropic's own reviewed directory.
2. **`skills` CLI** (`npx skills add …`) — the only install path that works across 71 agents.
3. **GitHub MCP server** — remote `https://api.githubcopilot.com/mcp/`, MIT, 33.6k.
4. **Context7** — remote `https://mcp.context7.com/mcp`, MIT, 63.0k. Kills API hallucination.
5. **Chrome DevTools / Playwright MCP** — real-browser debugging and automation, keyless.
6. **Reference memory + one of `basic-memory` / `mcp-memory-service`** — free persistent memory.
7. **MCP-SearXNG + `uvx workspace-mcp`** — keyless search and Google Workspace (free accounts).
8. **Serena** (`uv tool install serena-agent`) — LSP-grade code intelligence for any agent.
9. **Supabase/Neon remote** — Postgres for agents, `read_only=true` by default.
10. **Inspector + Snyk Agent Scan + MCPProxy** — the three things that run *before* trusting the rest.

## Sources & method

- Six parallel subagents, each with a disjoint slice: A vendor-official · B dev-tooling ·
  C data/search/memory/productivity · D plugins/skills/marketplaces · E bridges/gateways/security ·
  F hidden gems (100–2,500 stars, ≤60 days, license + CI). Raw slice files live at
  `/tmp/mcp-research/slice-{A..F}.md` (not committed); every row above was verified by the parent
  at merge time, at minimum by re-measuring its stars and its install target.
- Awesome lists mined locally (prefetches, not re-downloads): `punkpeye/awesome-mcp-servers`
  (1.4 MB), `wong2`, `appcypher`, `modelcontextprotocol/servers`, `hesreallyhim/awesome-claude-code`.
- Registries: official `registry.modelcontextprotocol.io` (paginated via `metadata.nextCursor`),
  npm (`registry.npmjs.org`, `api.npmjs.org` downloads), PyPI JSON, crates.io, Docker Hub
  (`/v2/repositories/` pulls).
- GitHub: `stargazerCount` page payload (exact, quota-free), `commits/<branch>.atom` (exact ISO
  timestamps), `raw.githubusercontent.com` (READMEs, LICENSE, CI workflows), and a handful of
  budgeted `api.github.com/repos/*` calls. GitHub *search* API: 10/min unauthenticated, used
  sparingly and never as the sole evidence.
- Two mid-run method corrections are on record: (1) the HTML badge-scraping recipe died on the
  client-rendered page — `"stargazerCount"` replaced it; (2) dead-end traps (`benborla29`,
  `mcp-scan`, `unla-ai/unla`, renamed `ruflo`, moved `supabase/mcp`, archived vendor repos) were
  each confirmed by a fetch that 404s or a doc that says the word.
- Slices overlapped on `okf-skills`, `capa`, `docs-mcp-server`, `mcp-scanner`, and the plugin
  catalogs; duplicates were folded into the strongest section and noted once.
- Anything marked "last commit" via shields.io is rounded by the badge service; "HTML"/"atom"
  values are exact.
