# TypeScript 7 migration — 2026-09-09

The Shell, Modules, shared package, relay, web app, tests, and scripts now compile or
receive type checks with TypeScript **7.0.2**. All three direct TypeScript declarations
(root, web, relay) use that release. The dependency tree contains no TypeScript 6
compiler or compatibility package. The compiler and its matching typed-lint engine
are pinned exactly; future updates go through the same validation gates. The package manager is pinned to **pnpm 12.3.4**
in the root manifest, CI, and both Docker builds. The build images install pnpm with
npm because their bundled Corepack expects the older `bin/pnpm.cjs` layout; pnpm 12
publishes native launchers at different paths. This was reproduced during the image build.

These were the latest stable registry releases when checked on 2026-09-09. Stable
means the npm `latest` tag, not a beta, release candidate, or daily development build.
The rest of the existing direct npm dependencies were already current. This scope
covers the npm dependency graph and its package manager; it does not change the
separate pinned Python, media, or operating-system packages in the production image.

## Why some tools had to change

| Previous dependency or use | Why a version bump is insufficient | Replacement |
| --- | --- | --- |
| typescript-eslint 8.70.0 | Its supported compiler range is `>=4.8.4 <6.1.0`. TypeScript 7.0 has no compatible legacy compiler API. The direct-upgrade trial refused to start typed ESLint. | Oxlint 1.82.0 with oxlint-tsgolint 7.0.2001. This engine uses TypeScript 7.0.2. |
| Three tests importing the TypeScript compiler API | `createSourceFile`, `SourceFile`, syntax guards, and visitors are absent from the TypeScript 7 package root. The direct-upgrade trial produced 31 errors in these three test files. | oxc-parser 0.149.0. It parses the same source assertions without a compiler API. Parse errors now fail the inspection explicitly. |
| ESLint React and syntax rules | Oxlint has native React rules but no native `no-restricted-syntax` rule. Removing the latter would remove the Google authorization boundary. | Native React rules plus oxlint-plugin-eslint 1.82.0, aliased as `eslint-js`, for the existing syntax selector. |
| Per-workspace ESLint runner | It existed to bound the memory of the old TypeScript API and ESLint processes. | One Oxlint invocation, followed by isolated policy probes. |

Microsoft documents the compiler API gap and a side-by-side TypeScript 6 alternative:
[TypeScript 7 release](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
The compatibility option passed an initial trial, but the requested migration removes
TypeScript 6 instead. A future API for TypeScript 7.1 is not a current substitute.

The supported typescript-eslint range is published in its
[dependency documentation](https://typescript-eslint.io/users/dependency-versions/).
Oxlint documents its stable TypeScript 7 engine and version convention in the
[type-aware release announcement](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable).
The `7.0.2001` engine version means TypeScript 7.0.2, engine patch 1.
The [ESLint-rule adapter documentation](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha.html)
explains the restricted-syntax alternative.

## Preserved checks and differences

The official Oxlint migration tool converted 111 configured rules. That count includes
configuration entries and is not proof that two linters behave identically. The
configuration retains typed checks, React hooks and refresh checks, and the web/server
and Google authorization boundaries. A later override explicitly allows the Google
connection to create auth clients; Oxlint cannot directly convert an ignored folder
inside an ESLint override.

Two omitted ESLint rules (`no-dupe-args` and `no-octal`) are superseded by strict-mode
parsing. The unsupported restricted-syntax rule runs through the adapter. Existing
suppressions were converted to Oxlint names. Four test assertions now safely handle
an optional value before accessing a property, addressing diagnostics surfaced by
the new linter without weakening the assertions.

`pnpm run lint:verify` uses a temporary source tree to test both accepted code and
intentional violations. Its 12 probes cover the Google auth allowance and restriction,
restricted imports, React hooks, hook dependencies, refresh exports, dropped promises,
unnecessary conditions, unnecessary assertions, and a scoped suppression. It is part
of the full lint gate. These probes establish the tested protections; they do not claim
complete semantic equivalence for every linter rule.

The three source-inspection suites still check declared Stores held by the Shell,
retired dual-write paths, and complete classification of relay state. Their 23 tests
passed after the parser change. Knip 6 already uses Oxc rather than the TypeScript
compiler API, so it needs no compatibility package:
[Knip 6 release](https://knip.dev/blog/knip-v6).

## Validation and tools

The full local check and all 2,376 unit tests passed after removal of TypeScript 6.
All 82 browser tests passed with the native compiler and pnpm 12.3.4. Both production
images built successfully. All nine production adapter canaries passed, and the running
app returned `{"ok":true}` from its health endpoint. The smoke run used a temporary
Workspace and its Compose project was shut down afterward.
`pnpm outdated -r --format json` returned `{}`, and `pnpm peers check` found no issues.

Firecrawl retrieved current primary release and compatibility pages. context-awesome
was used to find relevant tools, not as proof of their compatibility. gh_grep checked
upstream configurations, including
[Oxlint's type-aware engine requirement](https://github.com/oxc-project/oxc/blob/main/npm/oxlint/package.json).
The package versions were checked against the live npm registry. The migration was
first tested in an isolated worktree at baseline commit `e541353`.
