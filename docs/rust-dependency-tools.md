# Rust dependency version info (replacing the deprecated `serayuzgur.crates`)

_Researched 2026-10-20. Question: which free (no paid upsell) VS Code extension
or tool replaces the deprecated `serayuzgur.crates` for inline Cargo.toml
version info? Prices and activity read 2026-10-20._

## Verdict

**`BarbossHack.crates-io`** (MIT, marketplace-present, last commit 2026-07-26)
is the direct community fork of the original `crates` codebase. It keeps the
same inline version decorations and hover tooltips (`✅`/`❌ ${version}`) and
carries no paid tier. Caveat is bus-factor: 63 stars, 2 forks, one open PR
unmerged (see below). Pair it with the repo's existing Dependabot cargo config
(`.github/dependabot.yml`) for automated version-bump PRs; Dependabot gives no
inline hints, only PRs.

- Marketplace:
  https://marketplace.visualstudio.com/items?itemName=BarbossHack.crates-io
- Repo: https://github.com/BarbossHack/crates-io (MIT, created 2023-08-21).
- Last commit on `master`: 2026-07-26 (v0.7.7).
  Source: https://github.com/BarbossHack/crates-io/commits/master.atom.
- Features: inline version decorations, hover tooltips, Docs.rs integration,
  alternate registries, update-all command, disable-check comments.
- Activity caveat: PR #12 (feature completion, opened 2026-02-28) still
  unmerged; maintainer replied 2026-04-12 "I will take a look when I have
  time". Source: https://github.com/BarbossHack/crates-io/pull/12.

## Why not Dependi

`fill-labs.dependi` is the official successor by the same author, and its Core
tier is free with no subscription required. But the listing markets Pro
(vulnerability reports, private repo support) with free trials, so Core users
see upsell prompts for those features — the pressure the user objects to.
Skipped on preference, not on capability.

- Marketplace:
  https://marketplace.visualstudio.com/items?itemName=fill-labs.dependi

## Fallbacks if `crates-io` stalls

- `alfatm.fancy-crates`: inline status indicators (✅/🟨/🟧/🟥), cargo-deny
  advisories, alternate registries, sparse protocol. Free, no paid tier
  stated. Marketplace:
  https://marketplace.visualstudio.com/items?itemName=alfatm.fancy-crates.
- `washan.cargo-appraiser`: LSP server for Cargo.toml (decorations, hovers,
  features, code actions, cargo-audit integration). Free, multi-editor.
  Repo: https://github.com/washanhanzi/cargo-appraiser.
- `nemurubaka.cratesx` (CratesX): another Crates fork. License and activity
  not verified from a primary source; secondary candidate only. Marketplace:
  https://marketplace.visualstudio.com/items?itemName=nemurubaka.cratesx.

## What Dependabot already covers

`.github/dependabot.yml` configures the cargo ecosystem (weekly Monday,
grouped, `build` prefix) plus github-actions. Cargo is a supported ecosystem
per https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories.
No change needed: it opens version-bump PRs through the normal CI gate.

## What needs no extension

rust-analyzer's Cargo.toml inspections check whether referenced crates exist
and are used, with one-click fixes — but show no latest-available version
inline. Source: https://rust-analyzer.github.io/book/ (Inspections, "Rust |
Cargo.toml"). `cargo update` / `cargo-outdated` cover CLI workflows.
