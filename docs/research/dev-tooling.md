> Update, 2026-09-09: the TypeScript and lint recommendations below are historical.
> The [TypeScript 7 migration](typescript7-migration-2026-09-09.md) replaces the old
> compiler API and typed ESLint with current native tools. Other sections retain their original context.

# Dev-experience tooling research — 2026-08-25

Question: how to improve DX for this repo (linting, type checking, formatting,
testing, other devtools) without violating the simplicity-first culture in
AGENTS.md.

Method: two parallel research passes — (1) GitHub sweep of awesome lists
(`awesome-typescript`, `awesome-eslint`, `awesome-vite`, `awesome-vitest`,
`awesome-playwright`) and exemplary OSS configs, every tool claim verified
against the tool's own repo/docs; (2) Reddit / Stack Overflow / Hacker News
consensus 2025–2026, factual claims traced back to primary sources. Version
facts below were re-verified against the npm registry on 2026-08-25.

---

## TL;DR

| Verdict | Item |
|---|---|
| **Adopt now** | Pre-commit hooks (`simple-git-hooks` + `lint-staged`), GitHub Actions CI, Dependabot, `eslint-plugin-react-refresh`, version bumps (Vitest 3→4, Playwright, Vite 7→8) |
| **Opt-in** | `@vitest/coverage-v8` with modest thresholds, React component tests via jsdom + Testing Library |
| **Trial with caveat** | `eslint-plugin-import-x` (peer range doesn't yet declare ESLint 10) |
| **Watch, don't adopt** | TypeScript 7 / `tsgo` (RC), Oxlint type-aware mode (stable Jul 2026, but adds typescript-go dependency) |
| **Don't adopt here** | Biome/Oxlint/Oxfmt migration, Turbo/Nx, unicorn/SonarJS/regexp plugins, msw, lefthook, commitlint/semantic-release, `vite-plugin-checker`, Playwright sharding |

The single biggest gaps are **workflow** (no CI, no git hooks — nothing runs
`npm run check` automatically) rather than tool choice. The tool stack itself is
already close to what communities recommend for a repo this size.

## Current state (verified from repo configs)

- ESLint 10 flat config + typescript-eslint 8 typed linting (`projectService`),
  react-hooks plugin, custom ADR boundary rules (`eslint.config.js`)
- Prettier 3.9.6, config is `{ printWidth: 100 }` (`.prettierrc.json`)
- TypeScript 5.9 strict-plus (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `tsc -b` project
  references for shared/server (`tsconfig.base.json`)
- knip 6.32.2 over all four workspaces (`knip.json`)
- Vitest 3 unit tests, node env, no coverage config (`tests/vitest.config.ts`)
- Playwright e2e + @axe-core a11y, single worker, sequential
  (`tests/playwright.config.ts`)
- Root gate: `check` = typecheck && lint && format:check && knip && test;
  `check:all` adds e2e (`package.json`)
- **Absent:** any CI (no `.github/`), any git hooks, coverage tooling, React
  component/hook tests (~20 components/hooks in `apps/web/src` covered only via
  e2e)
- Repo home is GitHub (`nicolas-found42/chief-of-staff-demo`) → GitHub Actions
  is the natural CI target

## Version currency (npm registry, 2026-08-25)

| Package | Repo | Latest | Status |
|---|---|---|---|
| eslint | ^10.9.0 | 10.9.1 | current |
| typescript-eslint | ^8.67.0 | 8.68.0 | current |
| typescript | ~5.9.3 | 5.9.x (7.0 RC separate) | current |
| prettier | ^3.9.6 | 3.9.6 | current |
| knip | ^6.32.2 | 6.32.2 | current |
| react | ^19.2.8 | 19.x | current |
| **vitest** | **^3.0.0** | **4.1.11** | **one major behind** |
| **@playwright/test** | **^1.50.0** | **1.62.1** | **~12 minors behind** |
| **vite** | **^7.2.0** | **8.2.2** | **one major behind** |

Vitest 4 engines are `^20 || ^22 || >=24`, so the repo's `engines: >=20`
remains valid after upgrading. Vitest 4 shipped 2025-10 with stable Browser
Mode ([release post](https://vitest.dev/blog/vitest-4)). Vite 8 ships Rolldown
as bundler ([announcement](https://vite.dev/blog/announcing-vite8));
`@vitejs/plugin-react` 5.x supports it. Bump each in its own PR with a build +
e2e smoke.

---

## Linting

**Keep ESLint + typescript-eslint. Do not migrate to Biome/Oxlint/Oxfmt.**
Both research passes converge here, for the same reason: this repo's lint value
is concentrated in *typed* rules (`no-floating-promises` guarding the Run
engine's promises; the ADR boundary rules). Biome's type-aware linting remains
partial, and Oxlint's type-aware mode — stable since July 2026 with 59/61
typescript-eslint type-aware rules ported
([oxlint type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html),
[blog](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable)) — requires
the `tsgolint` Go binary wrapping typescript-go. Speed wins cited in threads
(81 s → 2.5 s) come from enterprise monorepos; this repo lints in seconds.
Representative sentiment: [Biome→ESLint regret thread](https://www.reddit.com/r/webdev/comments/1in18wd/switched_from_biomejs_to_eslint_whats_your_take/),
[HN on Biome speed vs rule coverage](https://news.ycombinator.com/item?id=43913950).

**Add: `eslint-plugin-react-refresh`** (one dep + one rule in the apps/web
override). Catches mixed component/non-component exports that break Vite HMR —
standard in Vite React starters
([repo](https://github.com/ArnaudBarre/eslint-plugin-react-refresh),
listed in [awesome-vite](https://github.com/vitejs/awesome-vite)).

**Trial: `eslint-plugin-import-x`.** Would make the workspace import boundary
self-checking beyond `no-restricted-imports` (`no-cycle`, `no-duplicates`,
autofixing `order`). Caveat found during verification: its peer range declares
ESLint `^8.57 || ^9`; on ESLint 10 it works via flat-config import but warns
under `npm ls` until v5 ([repo](https://github.com/un-ts/eslint-plugin-import-x)).
Try on a branch; defer if the peer warning is annoying.

**Rejected for this repo** (all real, actively maintained, wrong cost/benefit
at this size):
- `eslint-plugin-unicorn` — 300 mostly-stylistic rules; churn without signal
  ([repo](https://github.com/sindresorhus/eslint-plugin-unicorn))
- SonarJS — enterprise analyzer needing SonarCloud plumbing; overlaps typed
  linting already paid for ([repo](https://github.com/SonarSource/SonarJS))
- `eslint-plugin-regexp`, `-promise`, `-security`, `-no-secrets` — no complex
  regex/user-input surface; local-only app; `no-floating-promises` already
  covers the promise class ([via awesome-eslint](https://github.com/dustinspecker/awesome-eslint))
- `eslint-plugin-jsx-a11y` — runtime axe checks in e2e already cover a11y and
  catch what static rules can't
- Import-sorting plugins (`perfectionist`, `simple-import-sort`) — second sort
  owner; if sorting is wanted, own it in exactly one place
- Test-file lint plugins (`@vitest/eslint-plugin`,
  [eslint-plugin-playwright](https://github.com/playwright-community/eslint-plugin-playwright))
  — sensible later if spec count grows; low priority now

## Type checking

**Keep TS 5.9 + current flags.** The config is already stricter than typical
exemplar repos, and the two deliberately-absent flags are documented with
reasons (`tsconfig.base.json`) — leave them absent.

`tsc -b` already implies incremental builds via `.tsbuildinfo`. Optional
zero-dep tweak: `"incremental": true` for the two `--noEmit` passes (web,
tests) and `.gitignore` `*.tsbuildinfo`.

**Watch, don't adopt: TypeScript 7 (`tsgo`).** Program checking/watch/build
mode are done; language service and API are still in progress; the staging repo
is scheduled to archive as work merged into microsoft/TypeScript
([typescript-go](https://github.com/microsoft/typescript-go),
[announcement](https://devblogs.microsoft.com/typescript/typescript-native-port/)).
Community reports are positive on CLI check speed but mixed on editor stability
([TS 7 beta thread](https://www.reddit.com/r/typescript/comments/1srwc21/announcing_typescript_70_beta/),
[HN](https://news.ycombinator.com/item?id=43332830)). On a codebase this size
the absolute saving is seconds. Revisit when `typescript@7` GA lands in the
main package; swap is then `tsc -b` → `tsgo -b` in scripts.

**Rejected: `vite-plugin-checker`** — duplicates what `projectService` typed
linting plus `tsc -b`/`tsc --noEmit` already surface; community advice for
small projects converges on keeping type check in CI/terminal instead of a Vite
overlay ([repo](https://github.com/fi3ework/vite-plugin-checker)).

## Formatting

**Keep Prettier 3 — it is exactly current (3.9.6).** No plugins: import-order
belongs to at most one owner, sort-json/tailwind don't earn deps here. Biome
formatter / Oxfmt migrations save <1 s on this tree and buy formatting churn in
git history; consensus is "switch only if consolidating lint too"
([Oxfmt/Prettier thread](https://www.reddit.com/r/javascript/comments/1rx4wgw/vite_is_kinda_underwhelming_a_comprehensive/)).

## Testing

**Vitest stays the runner** — consensus default for any Vite project; Jest only
if inherited ([r/node thread](https://www.reddit.com/r/node/comments/1ioguv6/is_vitest_still_necessary_in_2025/)).
Upgrade `^3` → `^4` (see currency table).

**Coverage: opt-in, modest.** `@vitest/coverage-v8`, run in CI, thresholds like
70–85% lines with `perFile: true` scoped to `packages/shared` +
`apps/server/src` — the engine logic where regressions hurt. Community warning,
repeated across threads: aggressive per-file gates become maintenance burden on
small apps where e2e covers critical paths
([coverage docs](https://vitest.dev/guide/coverage.html),
[r/ExperiencedDevs thread](https://www.reddit.com/r/ExperiencedDevs/comments/1o25w35/what_is_your_automated_test_coverage_like/)).

**Component-test gap is real but optional.** ~20 React components/hooks in
`apps/web/src` are covered only through e2e. If unit-level coverage is wanted:
jsdom (or happy-dom) + Testing Library covers most logic fast; reserve Vitest
Browser Mode (stable in v4) for the few layout/CSS/`<dialog>`-dependent cases —
or keep relying on Playwright e2e for those
([browser-mode vs jsdom thread](https://www.reddit.com/r/webdev/comments/1rn912x/is_there_still_a_reason_to_use_jsdom_over_vitest/)).
Don't migrate everything to browser mode; install cost + slower feedback aren't
worth it for a demo app.

**Playwright: bump to current (1.62.1)**, keep `workers: 1` until wall time
hurts. Sharding/blob reporters/allure/monocart are premature below ~20 specs
with no CI consumer; `trace: retain-on-failure` +
`npx playwright show-trace` remains the right debugging loop
([microsoft/playwright](https://github.com/microsoft/playwright),
[via awesome-playwright](https://github.com/mxschmitt/awesome-playwright)).
Skip msw — the Fastify mock path already suffices
([mswjs/msw](https://github.com/mswjs/msw)).

## Other devtools

### Git hooks — the cheapest big win

Nothing guards commits today; whole-tree `check` takes tens of seconds, which
is why nobody would run it per-commit anyway. Strong cross-source consensus:
**pre-commit = staged files only (1–2 s); whole-tree checks belong in CI.**
Whole-tree pre-commit drives `--no-verify`
([lint-staged](https://github.com/lint-staged/lint-staged),
[thread](https://www.reddit.com/r/typescript/comments/1iged4b/do_you_guys_prefer_a_pipeline_that_commits/)).

Recommended shape:

```jsonc
// package.json
"simple-git-hooks": { "pre-commit": "npx lint-staged" },
"lint-staged": {
  "*.{ts,tsx}": ["prettier --write", "eslint --fix --max-warnings 0"],
  "*.{json,md,mjs,css}": ["prettier --write"]
}
```

Runner choice: `simple-git-hooks` (config lives in package.json, no extra
dotdir) is the community sweet spot for small repos
([repo](https://github.com/toplenboren/simple-git-hooks),
[comparison](https://www.andymadge.com/2026/03/10/git-hooks-comparison/));
`husky` is the more widely exemplified alternative — typescript-eslint itself
uses husky+lint-staged ([their repo](https://github.com/typescript-eslint/typescript-eslint)).
Either is fine; pick one. Keep knip and Playwright **out** of pre-commit —
both are branch-wide analyses, wrong granularity for staged files
([knip CI guide](https://knip.dev/guides/using-knip-in-ci)).

### CI — currently nothing verifies pushes

Minimal GitHub Actions mirroring the existing `check`/`check:all` split, the
same shape exemplar repos run
([example: vitest repo workflows](https://github.com/vitest-dev/vitest)):

```yaml
# .github/workflows/ci.yml (sketch)
jobs:
  check:   # checkout, setup-node, npm ci → typecheck, lint, format:check, knip
  test:    # npm test
  e2e:     # npm run build && npm run test:e2e; upload playwright-report artifact
```

### Dependency automation

Dependabot is enough at this size — zero-config `.github/dependabot.yml`,
weekly, group minor/patch. Renovate earns its config only if grouping/cooldowns
(`minimumReleaseAge`) matter
([docs.renovatebot.com](https://docs.renovatebot.com),
[Dependabot docs](https://docs.github.com/en/code-security/dependabot),
[sentiment thread](https://www.reddit.com/r/devops/comments/1pam23g/microservices_dependency_maintenance_hell_which/)).

### Already correct — no action

`tsx watch` for server dev (community default over ts-node; Node native TS
still emerging — [tsx](https://github.com/privatenumber/tsx)), knip as the
unused-code tool (current leader; depcheck is the weaker alternative —
[knip](https://github.com/webpro-nl/knip)), plain npm workspaces scripts as the
task runner (Turbo/Nx pay off at 8–10+ workspaces or with remote-cache needs —
[vercel/turbo](https://github.com/vercel/turbo);
[sentiment: overhead below ~6 packages](https://daily.dev/blog/monorepo-turborepo-vs-nx-vs-bazel-modern-development-teams/)),
`rollup-plugin-visualizer` ad-hoc only if bundle size ever questions arise
([repo](https://github.com/btd/rollup-plugin-visualizer)).

## Consensus vs contested

Strong consensus (safe): Vitest for Vite projects; staged-only pre-commit via
lint-staged with whole-tree checks in CI; knip in CI not pre-commit; npm
scripts beat task runners at 4 workspaces; V8 coverage provider with opt-in
modest thresholds; Dependabot sufficient for personal repos; tsx > ts-node.

Contested (taste, not dogma): Biome/Oxlint vs ESLint+Prettier (speed vs typed
rule completeness — typed completeness wins here); Vitest Browser Mode vs jsdom
(fidelity vs speed); commitlint/conventional commits (busywork for a repo with
no release pipeline — HN pushback thread:
[Stop Using Conventional Commits](https://news.ycombinator.com/item?id=48414027));
`vite-plugin-checker` (nice overlay, commonly disabled).

Scale-only advice explicitly ignored: Turbo/Nx caching, Oxlint+Oxfmt wholesale
migration, 85 %+ global per-file coverage gates, Lefthook parallel hooks,
Renovate+commitlint+semantic-release pipeline.

## Suggested adoption order

1. Git hooks: `simple-git-hooks` + `lint-staged` (~20 min, 2 dev-deps + package.json fields)
2. CI: `.github/workflows/ci.yml` + `.github/dependabot.yml` (~30 min, config-only)
3. Version bumps, one PR each: Playwright → 1.62 (`npx playwright install`), Vitest → 4, Vite → 8 (smoke web build + e2e)
4. `eslint-plugin-react-refresh` rule in apps/web override (~10 min)
5. Optional: `@vitest/coverage-v8` with server/shared thresholds; jsdom + Testing Library pilot on one hook
6. Trial on a branch: `eslint-plugin-import-x` (accepting the ESLint-10 peer caveat)

Everything else above is documented as a deliberate *don't*, so future
proposals can be checked against this page instead of re-researched.

## Sources

Primary: [typescript](https://github.com/microsoft/TypeScript) ·
[typescript-go](https://github.com/microsoft/typescript-go) ·
[native port announcement](https://devblogs.microsoft.com/typescript/typescript-native-port/) ·
[eslint](https://github.com/eslint/eslint) ·
[v10 release](https://eslint.org/blog/2026/02/eslint-v10.0.0-released/) ·
[typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) ·
[prettier](https://github.com/prettier/prettier) ·
[vite](https://github.com/vitejs/vite) ·
[Vite 8 announcement](https://vite.dev/blog/announcing-vite8) ·
[vitest](https://github.com/vitest-dev/vitest) ·
[Vitest 4 release](https://vitest.dev/blog/vitest-4) ·
[coverage guide](https://vitest.dev/guide/coverage.html) ·
[microsoft/playwright](https://github.com/microsoft/playwright) ·
[knip](https://github.com/webpro-nl/knip) ·
[knip CI guide](https://knip.dev/guides/using-knip-in-ci) ·
[oxc type-aware](https://oxc.rs/docs/guide/usage/linter/type-aware.html) ·
[biome](https://github.com/biomejs/biome) ·
[husky](https://github.com/typicode/husky) ·
[lint-staged](https://github.com/lint-staged/lint-staged) ·
[simple-git-hooks](https://github.com/toplenboren/simple-git-hooks) ·
[lefthook](https://github.com/evilmartians/lefthook) ·
[renovate](https://github.com/renovatebot/renovate) ·
[msw](https://github.com/mswjs/msw) ·
[tsx](https://github.com/privatenumber/tsx) ·
[turborepo](https://github.com/vercel/turbo) ·
[vite-plugin-checker](https://github.com/fi3ework/vite-plugin-checker) ·
[rollup-plugin-visualizer](https://github.com/btd/rollup-plugin-visualizer)

Discovery lists: [awesome-typescript](https://github.com/dzharii/awesome-typescript) ·
[awesome-eslint](https://github.com/dustinspecker/awesome-eslint) ·
[awesome-vite](https://github.com/vitejs/awesome-vite) ·
[awesome-vitest](https://github.com/porada/awesome-vitest) ·
[awesome-playwright](https://github.com/mxschmitt/awesome-playwright)

Community threads (sentiment; claims traced to sources above):
[Biome→ESLint](https://www.reddit.com/r/webdev/comments/1in18wd/switched_from_biomejs_to_eslint_whats_your_take/) ·
[HN Biome 15×](https://news.ycombinator.com/item?id=43913950) ·
[TS 7 beta](https://www.reddit.com/r/typescript/comments/1srwc21/announcing_typescript_70_beta/) ·
[HN 10× TypeScript](https://news.ycombinator.com/item?id=43332830) ·
[jsdom vs browser mode](https://www.reddit.com/r/webdev/comments/1rn912x/is_there_still_a_reason_to_use_jsdom_over_vitest/) ·
[Vitest necessity](https://www.reddit.com/r/node/comments/1ioguv6/is_vitest_still_necessary_in_2025/) ·
[pre-commit scope](https://www.reddit.com/r/typescript/comments/1iged4b/do_you_guys_prefer_a_pipeline_that_commits/) ·
[Renovate vs Dependabot](https://www.reddit.com/r/devops/comments/1pam23g/microservices_dependency_maintenance_hell_which/) ·
[Stop Using Conventional Commits](https://news.ycombinator.com/item?id=48414027) ·
[tsc -b patterns (SO)](https://stackoverflow.com/questions/75526278/what-are-the-recommended-ways-to-run-typescript-monorepos-in-dev-environment/75535745) ·
[hooks comparison 2026](https://www.andymadge.com/2026/03/10/git-hooks-comparison/) ·
[task runners for small monorepos](https://daily.dev/blog/monorepo-turborepo-vs-nx-vs-bazel-modern-development-teams/)
