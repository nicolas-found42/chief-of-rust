# LSP servers and oh-my-pi — 2026-08-29

Question: does oh-my-pi (omp harness) install LSP servers globally? What servers exist for ts/py/html/md and every other popular extension, and how do you add them so the omp `lsp` tool can use them?

Method: primary sources only — harness source docs read via `omp://` (which mirrors the installed binary's docs), the on-disk install at `/opt/homebrew/bin/omp` + `~/.omp/`, the repo's own configs, and each language server's owning GitHub repo / npm / docs site. Every table row links to its owner. Shell checks below were run on this workstation (macOS 25.4 Darwin arm64, omp 18.0.11) on 2026-08-29; "installed" findings are machine-local, "wiring" findings are repo-portable. **Update 2026-08-29 23:22 UTC:** a sibling agent installed 13 servers globally via brew/npm and created `~/.omp/agent/lsp.json` — §1.3–1.4 now show both the pre-install baseline and the post-install state; the TL;DR reflects the post-install state.

---

## TL;DR

| Verdict | Detail |
|---|---|
| **omp does NOT install any LSP server globally** | It ships a 54-entry *catalog* ([`defaults.json`](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/lsp/defaults.json) — 54 keys counted 2026-08-29 via `python -c "import json; print(len(json.load(open('defaults.json'))))"` → 54) and **auto-detects** binaries already on `PATH` / local bins. Zero downloads happen at install or startup. |
| **This repo has zero checked-in LSP config** | No `lsp.json` in the repo, no `.vscode/settings.json`, no editor LSP config. It relies on omp defaults + the user's `~/.omp/agent/lsp.json`. |
| **This machine now has 16 of 54 built-ins on PATH (was 2)** | **Post-install (23:22 UTC):** `clangd` + `sourcekit-lsp` (Xcode CLT) plus 14 newly installed: `typescript-language-server`, `vscode-html/css/json-language-server`, `yaml-language-server`, `bash-language-server`, `docker-langserver`, `marksman` 2026-02-08, `pyright-langserver` 1.1.413, `ruff` 0.16.5, `emmet-language-server`, `lua-language-server` 3.19.1, `tailwindcss-language-server`, `graphql-lsp` (via `graphql-language-service-cli` 3.5.0) — all on `/opt/homebrew/bin` and wired via `~/.omp/agent/lsp.json` (14 entries, valid JSON). Heavy servers `jdtls`/`metals`/`omnisharp` intentionally skipped (JVM); `gopls` skipped (Go not present). Pre-install baseline was 2/54 — see §1.4. |
| **Recommended add path (still valid)** | **Project-local npm devDeps** for JS-ecosystem servers + `pyright`/`ruff` via npm/pipx as appropriate, **pipx/brew** for Python/Rust/Go-native servers, **mason/bunx/npx ephemeral** only for ad-hoc use. Wire with `~/.omp/agent/lsp.json` (user-wide) or `<cwd>/.omp/lsp.json` (project override). Now that a user-global config exists, prefer updating it for user-wide servers and only add `package.json` devDeps for repo-pinned reproducibility. |

---

## 1. Current state — does oh-my-pi have global LSP servers?

- Binary: `/opt/homebrew/bin/omp`, Mach-O arm64, version `omp/18.0.11` (`omp --version` on 2026-08-29).
- Harness is the **pi / oh-my-pi coding agent** (also ships as `opencode-go`-flavored builds; the name `omp` is the `pi`/`oh-my-pi` CLI). Docs are served at `omp://` inside the harness itself — the same markdown that ships in `packages/coding-agent/src/lsp/` in the source repo.
- Home dir: `~/.omp/` contains `agent/` (canonical user config at `~/.omp/agent/config.yml`), `cache/`, `profiles/`, `logs/`, `natives/`, `browser-relay/`. **Before 23:22 UTC:** no `lsp.json` anywhere. **After 23:22 UTC:** `~/.omp/agent/lsp.json` exists — 14 servers (ts, html, css, json, yamlls, bashls, dockerls, marksman, pyright, ruff, emmet, lua, tailwindcss, graphql), valid JSON, pretty-printed; all 14 binaries verified on `/opt/homebrew/bin` at time of this update.
### 1.2 The harness does not install servers — it detects them

Primary source is `omp://lsp-config.md` + `omp://tools/lsp.md` + the code pointers they cite:

> "When no config file contributes a server override, OMP **auto-detects built-in servers** by intersecting two conditions: (1) cwd contains a `rootMarker`, (2) the server binary is **available — checked in supported project-local bin directories first** (`node_modules/.bin/`, venvs, Ruby binstubs, `bin/` for Go), **then `$PATH`**." — [`omp://lsp-config.md`](omp://lsp-config.md) § Auto-detection

> "Server config type: `packages/coding-agent/src/lsp/types.ts` (`ServerConfig`), Config loader: `packages/coding-agent/src/lsp/config.ts`, Built-in definitions: `packages/coding-agent/src/lsp/defaults.json`" — [`omp://lsp-config.md`](omp://lsp-config.md) header

> "`getServersForFile()` / `getServerForFile()` match by extension or basename, sort primary before linters" — [`omp://tools/lsp.md`](omp://tools/lsp.md)

Key behaviors (all from `omp://lsp-config.md` / `omp://tools/lsp.md`):

- **No download step.** There is no `omp lsp install`, no `mason` bootstrap, no bundled server. If the binary is absent the server is silently skipped.
- **Auto-detection is cwd-only** and gated on `rootMarkers` (e.g. `package.json`/`tsconfig.json` for TS, `pyproject.toml`/`.git` for Python). Wildcard markers like `*.cabal` match one level only.
- **Override files** — when at least one readable LSP config contributes a non-empty server map, the merge path replaces auto-detect. Locations (low→high precedence): `~/lsp.json` / `~/.lsp.json` (and `.yaml`/`.yml`), plugin LSP configs, `~/.claude/` / `~/.codex/` / `~/.gemini/` compat dirs, `<cwd>/.omp/lsp.*`, then `<cwd>/lsp.*` / `<cwd>/.lsp.*`. Inside one location, `lsp.json` > `.lsp.json` > `lsp.yaml` > `.lsp.yaml` > `lsp.yml` > `.lsp.yml`. The canonical omp user path is `~/.omp/agent/lsp.json` (default profile; `PI_CONFIG_DIR` / active profiles move it).
- **Merging is shallow per server** — higher precedence replaces whole object-valued fields (`settings`, `initOptions`, `capabilities`, `workspaceReadyTimings`), no deep merge.
- **`lsp` tool gating**: tool exists only when `session.enableLsp !== false` && `lsp.enabled` (default `true`). `config.yml` here has `task.enableLsp: true`, `lsp.lazy: true` (default), `lsp.diagnosticsOnEdit: true`, `lsp.formatOnWrite: true`. `lsp.lazy: true` means startup discovery surfaces servers as `available` (gray dot) without spawning; first `lsp` call or matching-file edit cold-starts.
- **lspmux multiplexing** (from `omp://tools/lsp.md`): `lsp.shared=true` (SDK default) reuses a broker-managed per-project LSP mux over a local socket/pipe; `PI_DISABLE_LSPMUX=1` disables it; only `rust-analyzer` is in `DEFAULT_SUPPORTED_SERVERS` for mux by default.

> Answer to the headline question: **no, oh-my-pi does not have LSP servers installed globally, and does not install them for you.** You bring the binaries; it brings the wiring.

### 1.3 What this repo currently wires

Checked 2026-08-29 against `main`:

- Glob `**/.vscode/**`, `**/.omp/**`, `**/lsp.*` → **no matches in the repo** (checked-in config — the repo itself still has zero LSP files).
- `package.json` workspaces `apps/*`, `packages/*`, `tests` — devDeps are lint/format/test only (`eslint`, `prettier`, `typescript ~5.9.3`, `vitest`, `tsx`). **No** `typescript-language-server`, `vscode-langservers-extracted`, `yaml-language-server`, `pyright`, `ruff`, `marksman`, `bash-language-server`, `lua-language-server`, `dockerfile-language-server-nodejs`, etc. — not in root, not in `apps/web`, `apps/server`, `relay`, `tests`.
- `node_modules/.bin/` contains only `tsc` (plus eslint/prettier/vitest) — none of the LSP bins. The 14 new servers live on `/opt/homebrew/bin` (global), not in `node_modules/.bin`.
- **User-global config:** `~/.omp/agent/lsp.json` → **now exists (created 23:22 UTC by sibling agent)** — 14 servers, valid JSON, covers ts/py/html/md + css/json/yaml/bash/docker/lua/emmet/tailwindcss/graphql. `~/.omp/lsp.json` / `~/lsp.json` → still absent. `~/.omp/agent/config.yml` has no inline `lsp.servers` block — wiring is via the new `lsp.json`.
- Therefore omp sessions in this repo are **no longer in pure auto-detect mode** — because a non-empty server map exists in `~/.omp/agent/lsp.json`, omp merges those 14 overrides onto `defaults.json` and then keeps only servers whose root markers match `<cwd>` and whose binary resolves (per `omp://lsp-config.md` Note on override mode). The other 40 built-ins remain eligible via defaults if their binaries appear later. `lsp.json` adds tuning: `typescript-language-server` sets `initOptions.hostInfo` + inlay hints, `yamlls` enables validate/format/hover, `bashls` sets `bashIde.globPattern`, `lua-language-server` sets `Lua.runtime.version: LuaJIT` + `diagnostics.globals: [vim]`, `marksman` sets `warmupTimeoutMs: 2000`, `ruff` is marked `isLinter: true`.
### 1.4 What is actually on `$PATH` right now

#### Post-install (2026-08-29 23:22 UTC) — current

All 14 sibling-installed servers verified (`which` + `--version` where applicable):

| Status | Binaries |
|---|---|
| **FOUND (16)** | `clangd` (`/usr/bin/clangd` Apple 21.0.0), `sourcekit-lsp` (`/usr/bin/sourcekit-lsp`) + 14 new on `/opt/homebrew/bin`: `typescript-language-server`, `vscode-html-language-server`, `vscode-css-language-server`, `vscode-json-language-server`, `yaml-language-server`, `bash-language-server`, `docker-langserver`, `marksman` 2026-02-08, `pyright-langserver` 1.1.413, `ruff` 0.16.5, `emmet-language-server`, `lua-language-server` 3.19.1, `tailwindcss-language-server`, `graphql-lsp` (from `/opt/homebrew/bin/graphql-lsp` via `graphql-language-service-cli` 3.5.0) |
| **MISSING (38)** | `deno`, `vscode-eslint-language-server` (not in the 14), `svelteserver`, `vue-language-server`, `astro-ls`, `basedpyright-langserver`, `pylsp`, `ty`, `jdtls`, `kotlin-lsp`, `metals`, `haskell-language-server-wrapper`, `ocamllsp`, `elixir-ls`, `expert`, `erlang_ls`, `gleam`, `solargraph`, `ruby-lsp`, `rubocop`, `intelephense`, `phpactor`, `omnisharp`, `terraform-ls`, `helm_ls`, `nixd`, `nil`, `ols`, `dart`, `texlab`, `prisma-language-server`, `vim-language-server`, `swiftlint`, `tlapm_lsp`, `gopls` (Go not present), `rust-analyzer`, `zls`, `biome` (heavy/JVM/Go/Rust/toolchain-gated — intentionally skipped) |
| Notes | `jdtls`/`metals`/`omnisharp` skipped as JVM-heavy per sibling; `gopls` skipped — `go` not on PATH. `vscode-eslint-language-server` is part of `vscode-langservers-extracted` but was not in the 14 — can be added with `brew install`/`npm i -D vscode-langservers-extracted` if eslint-as-LSP is wanted (repo already lints via `eslint` CLI). `graphql-lsp` is provided by `graphql-language-service-cli` and is found via defaults auto-detect (hence counted as FOUND even though `~/.omp/agent/lsp.json` previously omitted it — now added). |

Result now: **`lsp` tool's `diagnostics`/`definition`/`references`/`hover`/`symbols`/`rename` will work for TS/Py/HTML/MD + CSS/JSON/YAML/Bash/Dockerfile/Lua/Tailwind** (root markers for those exist in this repo: `package.json`, `tsconfig.json`, `.git`, `Dockerfile`, `docker-compose.yml`, `*.md`). Python needs a `pyproject.toml`/`requirements.txt`/`Pipfile` marker to activate `pyright`/`ruff`; clean `lsp status` should list the 14 as `configured`/`started`.

#### Pre-install baseline (2026-08-29 23:18 UTC) — preserved for provenance

Probed every `defaults.json` binary via `which <bin>` **before** the sibling install:

| Status | Binaries |
|---|---|
| **FOUND (2)** | `clangd` → `/usr/bin/clangd` (Apple clangd 21.0.0, Xcode CLT), `sourcekit-lsp` → `/usr/bin/sourcekit-lsp` (Xcode CLT Swift) |
| **MISSING (52)** | `typescript-language-server`, `deno`, `vscode-eslint-language-server`, `vscode-html-language-server`, `vscode-css-language-server`, `vscode-json-language-server`, `tailwindcss-language-server`, `svelteserver`, `vue-language-server`, `astro-ls`, `pyright-langserver`, `basedpyright-langserver`, `pylsp`, `ty`, `ruff`, `jdtls`, `kotlin-lsp`, `metals`, `haskell-language-server-wrapper`, `ocamllsp`, `elixir-ls`, `expert`, `erlang_ls`, `gleam`, `solargraph`, `ruby-lsp`, `rubocop`, `bash-language-server`, `lua-language-server`, `intelephense`, `phpactor`, `omnisharp`, `yaml-language-server`, `terraform-ls`, `docker-langserver`, `helm_ls`, `nixd`, `nil`, `ols`, `dart`, `marksman`, `texlab`, `graphql-lsp`, `prisma-language-server`, `vim-language-server`, `emmet-language-server`, `swiftlint`, `tlapm_lsp`, `gopls`, `rust-analyzer`, `zls`, `deno`, `biome` |
| **Package managers** | `npx` (npm 11.19.0) ✅, `bunx` (bun) ✅, `brew` ✅, `pip` ✅, `pipx` not on PATH, `mason` (neovim) not applicable headless |

At that point the `lsp` tool would no-op for TS/Py/HTML/MD — `getServersForFile()` returned empty and the tool reported `No language servers configured…`.

Source: `omp://lsp-config.md` § Built-in server list, which is generated from `packages/coding-agent/src/lsp/defaults.json`. 54 entries (2026-08-29 snapshot) — counted from [`packages/coding-agent/src/lsp/defaults.json`](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/lsp/defaults.json) on 2026-08-29 via `curl -sL https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/lsp/defaults.json | python -c "import json,sys; print(len(json.load(sys.stdin)))"` → 54 (also `python -c "import json; print(len(json.load(open('/tmp/defaults.json'))))"` → 54):

| Server key | Languages | Binary | Typical root markers |
|---|---|---|---|
| `rust-analyzer` | Rust | `rust-analyzer` | `Cargo.toml` |
| `clangd` | C/C++/ObjC | `clangd` | `compile_commands.json`, `.clangd`, `CMakeLists.txt` |
| `zls` | Zig | `zls` | `build.zig` |
| `gopls` | Go | `gopls` | `go.mod`, `go.work` |
| `typescript-language-server` | TS/JS | `typescript-language-server` | `package.json`, `tsconfig.json`, `jsconfig.json` |
| `denols` | TS/JS (Deno) | `deno` | `deno.json`, `deno.jsonc` |
| `biome` | TS/JS/JSON (linter) | `biome` | `biome.json` |
| `eslint` | TS/JS/Vue/Svelte | `vscode-eslint-language-server` | `eslint.config.*`, `.eslintrc.*` |
| `vscode-html-language-server` | HTML | `vscode-html-language-server` | `package.json`, `.git` |
| `vscode-css-language-server` | CSS/SCSS/Less | `vscode-css-language-server` | `package.json`, `.git` |
| `vscode-json-language-server` | JSON | `vscode-json-language-server` | `package.json`, `.git` |
| `tailwindcss` | HTML/CSS/TS | `tailwindcss-language-server` | `tailwind.config.*` |
| `svelte` | Svelte | `svelteserver` | `svelte.config.*` |
| `vue-language-server` | Vue | `vue-language-server` | `vue` in deps / `*.vue` |
| `astro` | Astro | `astro-ls` | `astro.config.*` |
| `pyright` | Python | `pyright-langserver` | `pyproject.toml`, `requirements.txt`, `.git` |
| `basedpyright` | Python | `basedpyright-langserver` | `pyproject.toml`, `.git` |
| `pylsp` | Python | `pylsp` | `setup.py`, `pyproject.toml` |
| `ty` | Python | `ty` | `pyproject.toml` |
| `ruff` | Python (linter) | `ruff` | `pyproject.toml`, `ruff.toml` |
| `jdtls` | Java | `jdtls` | `pom.xml`, `build.gradle`, `.git` |
| `kotlin-lsp` | Kotlin | `kotlin-lsp` | `build.gradle`, `settings.gradle` |
| `metals` | Scala | `metals` | `build.sbt` |
| `hls` | Haskell | `haskell-language-server-wrapper` | `*.cabal`, `stack.yaml` |
| `ocamllsp` | OCaml | `ocamllsp` | `dune-project`, `*.opam` |
| `elixirls` | Elixir | `elixir-ls` | `mix.exs` |
| `expert` | Elixir | `expert` | `mix.exs` |
| `erlangls` | Erlang | `erlang_ls` | `rebar.config` |
| `gleam` | Gleam | `gleam` | `gleam.toml` |
| `solargraph` | Ruby | `solargraph` | `Gemfile` |
| `ruby-lsp` | Ruby | `ruby-lsp` | `Gemfile` |
| `rubocop` | Ruby (linter) | `rubocop` | `Gemfile`, `.rubocop.yml` |
| `bashls` | Bash/Zsh | `bash-language-server` | `.git`, `package.json` |
| `lua-language-server` | Lua | `lua-language-server` | `.luarc.json` |
| `intelephense` | PHP | `intelephense` | `composer.json` |
| `phpactor` | PHP | `phpactor` | `composer.json` |
| `omnisharp` | C# | `omnisharp` | `*.sln`, `*.csproj` |
| `yamlls` | YAML | `yaml-language-server` | `.git`, `package.json` |
| `terraformls` | Terraform | `terraform-ls` | `*.tf` |
| `dockerls` | Dockerfile | `docker-langserver` | `Dockerfile`, `.git` |
| `helm-ls` | Helm | `helm_ls` | `Chart.yaml` |
| `nixd` | Nix | `nixd` | `flake.nix` |
| `nil` | Nix | `nil` | `flake.nix` |
| `ols` | Odin | `ols` | `ols.json` |
| `dartls` | Dart | `dart` | `pubspec.yaml` |
| `marksman` | Markdown | `marksman` | `.marksman.toml`, `.git` |
| `texlab` | LaTeX | `texlab` | `*.tex`, `.git` |
| `graphql` | GraphQL | `graphql-lsp` | `graphql.config.*`, `.graphqlrc*` |
| `prismals` | Prisma | `prisma-language-server` | `schema.prisma` |
| `vimls` | Vim script | `vim-language-server` | `.git` |
| `emmet-language-server` | HTML/CSS/JSX | `emmet-language-server` | `package.json`, `.git` |
| `sourcekit-lsp` | Swift | `sourcekit-lsp` | `Package.swift` |
| `swiftlint` | Swift (linter) | `swiftlint` | `.swiftlint.yml` |
| `tlaplus` | TLA+ | `tlapm_lsp` | `*.tla` |

File types each server handles are in `defaults.json` per entry; relevant slices: `typescript-language-server` → `.ts/.tsx/.js/.jsx/.mjs/.cjs`, `pyright`/`pylsp`/`ty` → `.py`, `vscode-html-language-server` → `.html`, `marksman` → `.md`, `yamlls` → `.yaml/.yml`, `bashls` → `.sh/.bash/.zsh`, `vscode-css-language-server` → `.css/.scss/.less`, `vscode-json-language-server` → `.json/.jsonc`.

Omp's `lsp` tool also documents custom linter adapters special-cased in the router: `BiomeClient` (`biome` CLI), `SwiftLintClient` (`swiftlint` CLI) — these are excluded from navigation/refactor and only participate in `diagnostics`. — [`omp://tools/lsp.md`](omp://tools/lsp.md) § Side Effects, Diagnostics.

---

## 3. Per-language servers — what to install for the ticket + other popular extensions

The ticket asks explicitly for `ts, py, html, md` and "all other popular file extensions". Below is each extension the repo actually contains (TS/JS/JSON/CSS/MD/YAML/Docker) plus the other built-ins users most often need, with the **canonical package** and **primary-source install doc** for each.

> Naming nuance: the user's list says e.g. "typescript-language-server" — the npm package IS `typescript-language-server`, the binary IS `typescript-language-server --stdio`. Other ecosystems follow the same pattern: `vscode-langservers-extracted` bundles the three `vscode-*-language-server` binaries, `yaml-language-server` provides `yaml-language-server`, etc. Table uses the binary omp expects (`command` column in `defaults.json`), which is what `which` must resolve.

### 3.1 Requested — TypeScript / JavaScript

| Concern | Recommended server | npm package & binary | Primary install doc |
|---|---|---|---|
| TS/JS diagnostics, go-to-def, rename, hover | **`typescript-language-server`** (wraps `tsserver`) | `typescript-language-server` → `typescript-language-server --stdio` | [`typescript-language-server` README](https://github.com/typescript-language-server/typescript-language-server#installation) |
| TS/JS linting (optional, already covered by `eslint` CLI in repo) | `eslint` via `vscode-eslint-language-server` | `vscode-langservers-extracted` → `vscode-eslint-language-server --stdio` | [`vscode-langservers-extracted` / `vscode-eslint-language-server`](https://github.com/hrsh7th/vscode-langservers-extracted) |

Notes:
- Requires `typescript` next to it (repo already has `typescript ~5.9.3` in root devDeps) — the server spawns `tsserver` from the project's `typescript` install.
- `deno` (`denols`) is the alternate for Deno projects; not needed here (`deno.json` absent). Install via `brew install deno` or `deno` official installer — [`deno` manual](https://docs.deno.com/runtime/manual/tools/lsp).
- `biome` is a linter/formatter adapter (CLI, not LSP stdio by default; omp uses a custom `BiomeClient` over `biome lint`/`biome check`). Package ` @biomejs/biome` → `biome` — [`biome` docs](https://biomejs.dev/guides/getting-started/).

### 3.2 Requested — Python

| Concern | Recommended server | Package & binary | Primary install doc |
|---|---|---|---|
| **Type checking (pick one)** | **`pyright`** (Microsoft, most widely adopted) — `pyright-langserver --stdio` | `pyright` (npm) or `pip install pyright` | [`microsoft/pyright` docs](https://microsoft.github.io/pyright/#/installation) |
|  | `basedpyright` (pyright fork, stricter) — `basedpyright-langserver --stdio` | `basedpyright` (pip) | [`detachhead/basedpyright`](https://github.com/detachhead/basedpyright#installation) |
|  | `ty` (Astral, Rust-based, very fast) — `ty server` | `ty` (pip/pipx, via `uv`) | [`astral-sh/ty`](https://github.com/astral-sh/ty) |
| **Lint/format** | **`ruff`** (Astral) — `ruff server` | `ruff` (pip/pipx) | [`astral.sh/ruff` — editor integration](https://docs.astral.sh/ruff/editors/) |
| **Legacy / all-in-one** | `pylsp` (python-lsp-server) — `pylsp` | `python-lsp-server` (pip) + plugins | [`python-lsp/python-lsp-server`](https://github.com/python-lsp/python-lsp-server#installation) |

For this repo (no Python code): the practical choice is **`pyright` via npm** (so it lives next to the JS toolchain) or **`ruff` via pipx/brew** if linting is wanted. If the project ever adds Python, prefer `basedpyright` or `ty` + `ruff` together.

### 3.3 Requested — HTML

| Server | Package & binary | Primary doc |
|---|---|---|
| **`vscode-html-language-server`** (VS Code's HTML LS, extracted) | `vscode-langservers-extracted` → `vscode-html-language-server --stdio` | [`hrsh7th/vscode-langservers-extracted`](https://github.com/hrsh7th/vscode-langservers-extracted) |

Same `vscode-langservers-extracted` bundle also provides the CSS and JSON servers (see §3.5). Omp's entry for it is `vscode-html-language-server`. Also relevant: `emmet-language-server` (`emmet-language-server --stdio`, npm `emmet-language-server`) and `tailwindcss-language-server` for Tailwind projects.

### 3.4 Requested — Markdown

| Server | Binary | Primary doc |
|---|---|---|
| **`marksman`** (Rust, most popular MD LS) | `marksman` / `marksman server` | [`artempyanykh/marksman`](https://github.com/artempyanykh/marksman#installation) |
| Alt: `markdown-oxide` | `markdown-oxide` | [`beeender/markdown-oxide`](https://github.com/beeender/markdown-oxide) |

Omp's built-in is `marksman`. Install via `brew install marksman` (macOS), `cargo install marksman`, or GitHub releases. Marksman respects `.marksman.toml` and `.git` as root markers — both exist here.

### 3.5 Other popular extensions present or likely in this repo

| Ext / language | Omp key | Binary | Package | Primary install doc |
|---|---|---|---|---|
| **CSS / SCSS / Less** | `vscode-css-language-server` | `vscode-css-language-server --stdio` | `vscode-langservers-extracted` (npm) | [same bundle](https://github.com/hrsh7th/vscode-langservers-extracted) |
| **JSON / JSONC** | `vscode-json-language-server` | `vscode-json-language-server --stdio` | `vscode-langservers-extracted` | [same](https://github.com/hrsh7th/vscode-langservers-extracted) |
| **YAML** | `yamlls` | `yaml-language-server --stdio` | `yaml-language-server` (npm) | [`redhat-developer/yaml-language-server`](https://github.com/redhat-developer/yaml-language-server#installation) |
| **Bash / Zsh** | `bashls` | `bash-language-server start` | `bash-language-server` (npm) | [`bash-lsp/bash-language-server`](https://github.com/bash-lsp/bash-language-server#installation) |
| **Dockerfile** | `dockerls` | `docker-langserver --stdio` | `dockerfile-language-server-nodejs` (npm) | [`rcjsuen/dockerfile-language-server-nodejs`](https://github.com/rcjsuen/dockerfile-language-server-nodejs#installation) |
| **Go** | `gopls` | `gopls` | `golang.org/x/tools/gopls` (go install) / `brew install gopls` | [`golang.org/x/tools/gopls` docs](https://go.dev/gopls/) |
| **Rust** | `rust-analyzer` | `rust-analyzer` | `rustup component add rust-analyzer` / `brew install rust-analyzer` | [`rust-lang/rust-analyzer` manual](https://rust-analyzer.github.io/manual.html#installation) |
| **Lua** | `lua-language-server` | `lua-language-server` | `lua-language-server` (brew / GitHub releases) | [`LuaLS/lua-language-server` wiki](https://luals.github.io/wiki/installation/) |
| **GraphQL** | `graphql` | `graphql-lsp server -m stream` | `graphql-language-service-cli` (npm) | [`graphql/graphiql` — language service](https://github.com/graphql/graphiql/tree/main/packages/graphql-language-service-cli#installation) |
| **Prisma** | `prismals` | `prisma-language-server --stdio` | `prisma` (npm, ships LS) | [`prisma/language-tools`](https://github.com/prisma/language-tools#installation) |
| **Terraform** | `terraformls` | `terraform-ls serve` | `hashicorp/terraform-ls` (brew / releases) | [`hashicorp/terraform-ls` docs](https://github.com/hashicorp/terraform-ls#installation) |
| **Helm** | `helm-ls` | `helm_ls serve` | `helm-ls` (Go, `go install`) | [`mrjosh/helm-ls`](https://github.com/mrjosh/helm-ls#installation) |
| **Nix** | `nixd` / `nil` | `nixd` / `nil` | `nixd` / `nil` (nixpkgs / brew) | [`nix-community/nixd`](https://github.com/nix-community/nixd#installation) · [`oxalica/nil`](https://github.com/oxalica/nil#installation) |
| **Java** | `jdtls` | `jdtls` | `eclipse-jdtls` (brew / releases) | [`eclipse-jdtls/eclipse.jdt.ls`](https://github.com/eclipse-jdtls/eclipse.jdt.ls#installation) |
| **C#** | `omnisharp` | `omnisharp` | `omnisharp-roslyn` (brew / releases) | [`OmniSharp/omnisharp-roslyn`](https://github.com/OmniSharp/omnisharp-roslyn#installation) |
| **Ruby** | `ruby-lsp` / `solargraph` | `ruby-lsp` / `solargraph` | `ruby-lsp` / `solargraph` gems | [`Shopify/ruby-lsp`](https://github.com/Shopify/ruby-lsp#installation) |
| **PHP** | `intelephense` / `phpactor` | `intelephense --stdio` / `phpactor language-server` | npm `intelephense` / `phpactor` phar | [`bmewburn/intelephense`](https://github.com/bmewburn/intelephense-docs) |
| **LaTeX** | `texlab` | `texlab` | `texlab` (cargo / brew) | [`latex-lsp/texlab`](https://github.com/latex-lsp/texlab#installation) |
| **Emmet** | `emmet-language-server` | `emmet-language-server --stdio` | `emmet-language-server` (npm) | [`olrtg/emmet-language-server`](https://github.com/olrtg/emmet-language-server#installation) |

---

## 4. How to add them

### 4.1 Strategy — where to install

Omp resolves in order: **local bins (`node_modules/.bin`, venv `.venv/bin`, Ruby binstubs, `bin/` for Go) → `$PATH`**. So there are three viable layers:

| Layer | When to use | Example | Trade-off |
|---|---|---|---|
| **Project-local npm devDeps** (recommended for JS-ecosystem servers) | JS/TS/HTML/CSS/JSON/YAML/Bash/Docker/GraphQL/Emmet/Tailwind/Svelte/Vue/Astro — anything that is an npm package | `npm i -D typescript-language-server vscode-langservers-extracted yaml-language-server bash-language-server dockerfile-language-server-nodejs` | Pinned in `package-lock.json`, reproducible, no global pollution. Omp finds via `node_modules/.bin` without `$PATH`. |
| **User-global via brew/pipx/go/rustup** | Native binaries: `marksman`, `gopls`, `rust-analyzer`, `lua-language-server`, `taplo`, `ruff`, `ty`, `basedpyright`, `terraform-ls` | `brew install marksman lua-language-server gopls` · `pipx install ruff` · `rustup component add rust-analyzer` | Survives `rm -rf node_modules`, works across all checkouts. Must be kept updated separately. |
| **Ephemeral via `npx`/`bunx`** (ad-hoc only) | One-off checks, CI without install step | `npx -y typescript-language-server --stdio` — but omp **does not** invoke `npx` for you; you'd need a shim | **Not recommended** as the LSP `command`: it re-downloads on cold start and adds ~1–3 s launch latency. Use only for manual `diagnostics` fallback. |

Single best default for **this repo** (JS/TS heavy, no Python/Go/Rust code): **add the npm servers as project-local devDeps, add `marksman` via `brew` (or `cargo`) for Markdown.** That's the minimal set that covers the ticket's `ts/py/html/md` and the repo's actual file types.

### 4.2 Concrete steps — minimal set for this repo

```bash
# 1) JS-ecosystem servers (pinned, reproducible — lives in node_modules/.bin)
npm i -D \
  typescript-language-server \
  vscode-langservers-extracted \
  yaml-language-server \
  bash-language-server \
  dockerfile-language-server-nodejs \
  emmet-language-server

# Optional but recommended for Python if the repo ever adds .py:
npm i -D pyright          # provides pyright-langserver --stdio
# or: pipx install basedpyright ruff   # native Python servers

# 2) Native Markdown server (not an npm package — pick one)
brew install marksman
# alt: cargo install marksman
# alt (manual): download from https://github.com/artempyanykh/marksman/releases

# 3) Verify binaries resolve (omp's own check order)
ls node_modules/.bin/typescript-language-server \
   node_modules/.bin/vscode-html-language-server \
   node_modules/.bin/yaml-language-server \
   node_modules/.bin/bash-language-server
which marksman && marksman --version
which typescript-language-server || echo "use node_modules/.bin (omp checks there first)"
```

After this, no config file is needed — omp's auto-detect will pick them up because the repo already contains their `rootMarkers` (`package.json`, `tsconfig.json`, `.git`, `Dockerfile`, `docker-compose.yml`, `*.md` with `.git`). Confirm with:

```bash
# omp lsp status via the lsp tool (or just trigger any lsp action):
# in an omp session, run the lsp tool:
#   action=status  → should list typescript-language-server, vscode-*-language-server, yamlls, bashls, dockerls, marksman as available/started
```

If you prefer explicit pinning (e.g. to override `args` or set `settings`), create the canonical user file so it applies everywhere:

```bash
mkdir -p ~/.omp/agent
cat > ~/.omp/agent/lsp.json <<'JSON'
{
  "servers": {
    "typescript-language-server": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "fileTypes": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      "rootMarkers": ["package.json", "tsconfig.json", "jsconfig.json"]
    },
    "marksman": {
      "command": "marksman",
      "args": ["server"],
      "fileTypes": [".md"],
      "rootMarkers": [".marksman.toml", ".git"]
    }
  }
}
JSON
```

Project-scoped override (e.g. disable `eslint` LS in this repo only): `mkdir -p .omp && cat > .omp/lsp.json` with `{"servers":{"eslint":{"disabled":true}}}` — project overrides user per the precedence table in [`omp://lsp-config.md`](omp://lsp-config.md).

Full per-server override shape is documented in [`omp://lsp-config.md`](omp://lsp-config.md) § `ServerConfig` (`command`/`args`/`fileTypes`/`rootMarkers`/`settings`/`initOptions`/`disabled`/`warmupTimeoutMs`/`isLinter`/`capabilities`).

### 4.3 Concrete steps — exhaustive "every popular extension" install

If you want **all the built-ins you have toolchain for** on macOS (without heavyweight JVM/Ruby/PHP installs), run:

```bash
# npm bundle (covers ~10 servers)
npm i -D \
  typescript-language-server \
  vscode-langservers-extracted \
  yaml-language-server \
  bash-language-server \
  dockerfile-language-server-nodejs \
  graphql-language-service-cli \
  emmet-language-server \
  pyright \
  tailwindcss-language-server \
  svelte-language-server \
  @vue/language-server \
  astro-language-server \
  prisma

# Native / brew layer
brew install marksman lua-language-server gopls rust-analyzer texlab terraform-ls
# Go-native extras
go install github.com/mrjosh/helm-ls@latest          # helm_ls
go install github.com/nix-community/nixd@latest      # nixd (if not via nixpkgs)
# Python linter (fastest)
pipx install ruff
# or: brew install ruff
```

Java/Kotlin/Scala/Haskell/OCaml/Elixir/Erlang/Gleam/Ruby/PHP/C#/Dart/SwiftLint/TLA+ servers require their respective SDKs (JDK, Gleam, Elixir, Ruby gems, Composer, .NET). Install only if you work in that language — omp will silently ignore the missing ones.

### 4.4 Omp wiring — what to change (and not)

- **No code change.** `defaults.json` already contains all 54 servers ([`defaults.json`](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/lsp/defaults.json) — 54 keys counted 2026-08-29). You only need binaries + optional JSON overrides.
- **Editor LSP is separate.** Omp's `lsp` tool is **process-local to the agent** — it does not configure VS Code / Neovim / Helix. If you also want editor hover/definitions, configure the *editor* independently (e.g. VS Code's `vscode settings`, Neovim `nvim-lspconfig`, Helix `languages.toml`). They can reuse the same globally-installed binaries.
- **Workspace diagnostics shortcut**: `lsp` action `diagnostics` with `file:"*"` runs `npx tsc --noEmit` (TS), `cargo check` (Rust), `go build ./...` (Go), or `pyright` (Python) depending on detected project type — this works even when the matching LSP server binary is absent, as long as the underlying CLI (`tsc`, `cargo`, `go`, `pyright`) exists. Useful for CI smoke without full LSP.

---

## 5. Verification

Run these in the repo root, in any omp-enabled session (or plain shell for the `which` parts):

```bash
# 1) Binaries resolve in omp's search order
for bin in typescript-language-server vscode-html-language-server vscode-css-language-server vscode-json-language-server yaml-language-server bash-language-server docker-langserver marksman pyright-langserver ruff emmet-language-server; do
  printf "%-35s " "$bin:"
  ls -1 node_modules/.bin/$bin 2>/dev/null && echo "(local)" && continue
  which "$bin" 2>/dev/null && echo "(PATH)" && continue
  echo "MISSING"
done

# 2) Omp sees them (requires an omp session — uses the lsp tool)
# action=status  (no file) → Language servers: typescript-language-server (configured...), marksman (...), etc.
# action=diagnostics file="apps/web/src/App.tsx"
# action=definition  file="apps/web/src/App.tsx" line=10 symbol="App"
# action=hover       file="apps/web/src/App.tsx" line=10 symbol="App"

# 3) Single-file diagnostics still works without LSP (fallback path)
npx tsc --noEmit --pretty false 2>&1 | head -20
# For py: npx pyright --version ; ruff check --help | head -5
# For md: marksman --version
```

Expected after §4.2 minimal install: `typescript-language-server` and the three `vscode-*-language-server` bins show `(local)`, `marksman` shows `(PATH)`, `lsp status` lists them as `configured`/`started`, and `diagnostics` on a `.ts` file returns `OK` or grouped diagnostics (not `No language servers configured`).

On this machine *before* install (verified 2026-08-29): only `clangd`/`sourcekit-lsp` show `(PATH)`; every other bin prints `MISSING` and `lsp status` reports `No language servers configured for this project` for the repo's file types.

---

## 6. Recommendations for this repo

1. **Do: add `typescript-language-server` + `vscode-langservers-extracted` + `yaml-language-server` + `bash-language-server` + `dockerfile-language-server-nodejs` as root devDeps.** Small, pinned, enables the `lsp` tool's core value (rename/navigation/diagnostics) for the files the repo actually has. PR is ~5 lines in `package.json` + lockfile; no config needed.

2. **Do: `brew install marksman` on contributor machines** (document in `ONBOARDING.md` / `docs/agents/`). Not an npm package; local install is the right layer. Revisit `markdown-oxide` only if `marksman` maintenance stalls.

3. **Don't: add Python/Go/Rust LSP servers to this repo's devDeps.** No `.py`/`.go`/`.rs` files exist; global install on the machines that need them is cheaper than bloating every CI checkout.

4. **Don't: add an `lsp.json` to the repo unless you need non-default `args`/`settings`.** Auto-detect already maps `package.json`→TS and `.git`→HTML/CSS/JSON/MD. Only check in `.omp/lsp.json` if you want to `disabled: true` a noisy server (e.g. `eslint` LS when the project's `eslint` CLI is the linter of record) or tune `settings`.

5. **Consider: document the `diagnostics` fallback** (`npx tsc --noEmit` etc.) in the "check" pipeline — it's the one LSP-adjacent thing that works without any server install and is already what `npm run typecheck` does.

---

## 7. Sources

Primary sources only. Every server row above is grounded in its owning repo/docs.

**Harness / LSP plumbing**

- [`omp://lsp-config.md`](omp://lsp-config.md) — auto-detect, config file precedence, `ServerConfig` fields, built-in list; mirrors `packages/coding-agent/src/lsp/config.ts` + `packages/coding-agent/src/lsp/defaults.json`.
- [`omp://tools/lsp.md`](omp://tools/lsp.md) — tool actions, routing, `lspmux`/broker sharing, timeouts/caps, fallback workspace diagnostics.
- [`omp://settings.md`](omp://settings.md) — `lsp.lazy`, `lsp.diagnosticsOnEdit`, `lsp.formatOnWrite`, `lsp.shared`.
- On-disk: `/opt/homebrew/bin/omp` 18.0.11, `~/.omp/agent/config.yml` (2026-08-29 snapshot — `task.enableLsp: true`, `lsp.lazy: true`, no `lsp.json`).

**Language Server Protocol**

- [Language Server Protocol — Specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) — `language-server-protocol.github.io` / `microsoft.github.io/language-server-protocol`.

**Per-server — TypeScript / JS**

- [`typescript-language-server/typescript-language-server`](https://github.com/typescript-language-server/typescript-language-server#installation) — install via `npm i -D typescript-language-server`, run `typescript-language-server --stdio`.
- [`hrsh7th/vscode-langservers-extracted`](https://github.com/hrsh7th/vscode-langservers-extracted) — npm bundle providing `vscode-html-language-server`, `vscode-css-language-server`, `vscode-json-language-server`, `vscode-eslint-language-server` (`--stdio`).
- [`deno` manual — LSP](https://docs.deno.com/runtime/manual/tools/lsp) — `deno` binary doubles as LS (`denols`).
- [`biomejs/biome`](https://biomejs.dev/guides/getting-started/) — `@biomejs/biome` → `biome` CLI (omp uses custom `BiomeClient`).
- [`tailwindlabs/tailwindcss-intellisense` / `tailwindcss-language-server`](https://github.com/tailwindlabs/tailwindcss-intellisense#installation) — `tailwindcss-language-server --stdio`.
- [`sveltejs/language-tools`](https://github.com/sveltejs/language-tools#installation) — `svelteserver --stdio`.

**Per-server — Python**

- [`microsoft/pyright`](https://microsoft.github.io/pyright/#/installation) — `pyright` (npm) / `pip install pyright` → `pyright-langserver --stdio`.
- [`detachhead/basedpyright`](https://github.com/detachhead/basedpyright#installation) — `pip install basedpyright` → `basedpyright-langserver --stdio`.
- [`astral-sh/ty`](https://github.com/astral-sh/ty) — `pip install ty` / `uv` → `ty server`.
- [`astral.sh/ruff` — Editor integration](https://docs.astral.sh/ruff/editors/) — `pipx install ruff` / `brew install ruff` → `ruff server`.
- [`python-lsp/python-lsp-server`](https://github.com/python-lsp/python-lsp-server#installation) — `pip install python-lsp-server` → `pylsp`.

**Per-server — HTML / CSS / JSON / YAML / Markdown / Shell / Docker**

- [`redhat-developer/yaml-language-server`](https://github.com/redhat-developer/yaml-language-server#installation) — `yaml-language-server` (npm) → `yaml-language-server --stdio`.
- [`artempyanykh/marksman`](https://github.com/artempyanykh/marksman#installation) — `brew install marksman` / `cargo install marksman` → `marksman server`.
- [`beeender/markdown-oxide`](https://github.com/beeender/markdown-oxide) — alt MD LS (`markdown-oxide`).
- [`bash-lsp/bash-language-server`](https://github.com/bash-lsp/bash-language-server#installation) — `bash-language-server` (npm) → `bash-language-server start`.
- [`rcjsuen/dockerfile-language-server-nodejs`](https://github.com/rcjsuen/dockerfile-language-server-nodejs#installation) — `dockerfile-language-server-nodejs` → `docker-langserver --stdio`.
- [`LuaLS/lua-language-server`](https://luals.github.io/wiki/installation/) — `brew install lua-language-server` / releases → `lua-language-server`.
- [`olrtg/emmet-language-server`](https://github.com/olrtg/emmet-language-server#installation) — `emmet-language-server` (npm).

**Per-server — other popular**

- [`golang.org/x/tools/gopls`](https://go.dev/gopls/) — `go install golang.org/x/tools/gopls@latest` / `brew install gopls`.
- [`rust-lang/rust-analyzer` manual](https://rust-analyzer.github.io/manual.html#installation) — `rustup component add rust-analyzer`.
- [`graphql/graphiql` — `graphql-language-service-cli`](https://github.com/graphql/graphiql/tree/main/packages/graphql-language-service-cli#installation) — `graphql-language-service-cli` → `graphql-lsp server -m stream`.
- [`prisma/language-tools`](https://github.com/prisma/language-tools#installation) — `prisma` npm ships `prisma-language-server`.
- [`hashicorp/terraform-ls`](https://github.com/hashicorp/terraform-ls#installation) — `brew install terraform-ls` → `terraform-ls serve`.
- [`mrjosh/helm-ls`](https://github.com/mrjosh/helm-ls#installation) — `go install github.com/mrjosh/helm-ls@latest`.
- [`nix-community/nixd`](https://github.com/nix-community/nixd#installation) · [`oxalica/nil`](https://github.com/oxalica/nil#installation).
- [`eclipse-jdtls/eclipse.jdt.ls`](https://github.com/eclipse-jdtls/eclipse.jdt.ls#installation) (Java), [`OmniSharp/omnisharp-roslyn`](https://github.com/OmniSharp/omnisharp-roslyn#installation) (C#), [`Shopify/ruby-lsp`](https://github.com/Shopify/ruby-lsp#installation) (Ruby).
