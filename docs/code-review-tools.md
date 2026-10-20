# AI code review tools for a private Rust repo on GitHub's free plan

_Researched 2026-10-18. Question: which AI code-review programs — beyond Sourcery, CodeRabbit and Qodo
Merge — actually review pull requests, are still shipping, publish first-party docs today, and are worth
considering for a private Rust workspace on GitHub's free plan? All prices read 2026-10-18._

## Verdict

**Three fit this repo without a sales call, and only one of them is free at the size this repo is.**

1. **Greptile Starter** — the only free tier here that is explicitly *unlimited repositories for one
   active developer*, states "All languages supported", and posts inline PR comments from a GitHub App.
   50 credits/month, and a base review costs 1 credit
   (<https://www.greptile.com/pricing>, <https://www.greptile.com/docs/introduction>).
2. **GitHub Copilot code review** — $10 USD/month at the individual Pro tier, native reviewer on the PR
   itself (no third-party app, no repo visibility question), and its docs say it "reviews code written in
   any language". It is the cheapest *paid* option that needs no new vendor relationship
   (<https://docs.github.com/en/copilot/get-started/plans>,
   <https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review>).
3. **SonarQube Cloud, free tier** — private projects up to 50k LOC at $0, Rust is a checked language in
   Cloud, and the pull-request decoration fails the gate on the PR. The catch is documented: on Free,
   pull-request analysis runs only when the PR targets the main branch
   (<https://www.sonarsource.com/plans-and-pricing/>,
   <https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis.md>).

Runners-up, both for a specific reason rather than overall fit: **Semgrep Free Edition** (10 private
repos, Rust GA with 40+ Pro rules, $0 — but security findings only) and **CodeScene Standard** (the only
vendor here that documents Rust-specific *test-code* rule configuration; €18 per active author per month,
unlimited private repositories). **Qodana** is the one to skip: its Rust linter exists, but only under
Ultimate/Ultimate Plus, licensed per active contributor with a **minimum of three contributors** — a
measured floor of $15 USD/month.

**Why the size caps matter here, not just the feature tables.** This worktree measures **39,944 Rust lines
across 63 files** (`find crates -name '*.rs' | xargs wc -l`) and **40,199 lines** across `.rs`, `.html`,
`.css`, `.js`, `.sql`, `.py`, `.sh` (`git ls-files | grep -E '\.(rs|html|css|js|sql|py|sh)$' | xargs wc -l`).
Sonar's free ceiling is 50k LOC, counted on the largest branch of each private project
(<https://www.sonarsource.com/plans-and-pricing/>), so this repo fits under it with roughly 20% headroom.
Greptile's 50 free credits cover 50 base reviews/month; this repo has **19 PRs, 18 merged**
(`gh pr list --state all --limit 100 --json state` — 18 `MERGED`, 1 `CLOSED`), so credit exhaustion is a
non-issue at the observed volume. Semgrep Free has the same $0 shape and Rust GA, but only security
findings — it does not replace a general reviewer.

## Comparison

`§` points at the qualifier whose facts table cites the owning URLs.

| Tool | Review trigger | Inline PR comments | Rust listed | Price (2026-10-18) | Private repo, free GitHub plan | Deployment | What it analyzes | § |
|---|---|---|---|---|---|---|---|---|
| **Greptile** | GitHub App; auto on open/push/rebase (configurable) or `@greptileai` | yes, ~3 min, severity badges, "Fix with your Agent" | yes — "All languages supported" | Starter **free** (1 active dev, 50 credits/mo); Pro **$30 USD/seat/mo** + $1/credit | yes — Starter lists "Unlimited repositories" with no visibility caveat [INFERENCE from the absence of a public-only term] | cloud, Docker/K8s self-host, air-gapped | whole-repo graph + LLM agent; optional sandbox test run | 1 |
| **GitHub Copilot code review** | reviewer assignment on the PR; optional automatic review; CLI/REST `copilot-pull-request-reviewer[bot]` | yes, High/Medium/Low, one-click suggestions | "any language" | requires a Copilot plan; Pro **$10 USD/mo**; Free plan **excludes** code review; per-review AI-credit estimates $0.05–$1 (Lite) / $0.25–$5 (Balanced) | yes | GitHub.com only (not GHES) | LLM + agentic repo context via Actions; MCP/skills aware | 2 |
| **SonarQube Cloud** | automatic analysis on PR creation and push; PR decoration + quality gate | yes — "issues may be reported as inline annotations" | yes (Community Build, Cloud, Server) | Free **$0** private ≤50k LOC; Team from **$34 USD/mo** for 100k LOC | yes, ≤50k LOC — but Free only analyzes PRs targeting main | Cloud SaaS; Server self-hosted | deterministic rules; AI CodeFix/Remediation Agent for fixes | 3 |
| **Semgrep (Code + Multimodal)** | Semgrep platform + `semgrep ci` in CI; PR/MR comments; Managed Scans | yes | yes — GA, cross-function dataflow, 40+ Pro rules | Free **$0** (10 repos, 10 contributors, 60 AI credits); Teams from **$30 USD/mo/contributor** | yes — Free allows 10 private repos | SaaS platform; scanning can stay in your CI; on-prem SCM on Enterprise | pattern + dataflow SAST, then LLM triage/explain/remediate | 4 |
| **CodeScene** | PR/MR integration via webhooks on open or update; quality gate profile | check + findings; per-PR suppression documented | yes — full support incl. Rust test-code rules | Standard **€18**/active author/mo billed yearly; Pro **€27**; OSS free | yes — "Unlimited private repositories" on Standard | cloud or on-prem | deterministic Code Health (behavioural + structural), not LLM | 5 |
| **Bito** | GitHub App (cloud or self-managed), webhooks service, GitHub Actions, CLI | yes, posted as PR comments | yes — AI review only; no Rust linter | Team **$12 USD/seat/mo** annual ($15 monthly) incl. 5K lines/seat, then $5/1K; free plan = summaries only | on a paid plan; free plan gives summaries | Bito Cloud, self-hosted, on-prem | LLM + symbol index/AST/embeddings, optional linters | 6 |
| **DeepSource** | GitHub App; static analysis + AI Review on every PR; CLI | PR feedback; AI Review augments static-analysis results, or runs on mention | yes — Rust GA, versions ≤1.93 | OSS **free** (public repos, 1,000 PRs/mo); Team **$24 USD/user/mo** billed yearly; AI Review $8 per 10K LOC | no on free (public repos only) | cloud; Enterprise self-hosted, BYOK | Rust static analyzer + LLM AI Review | 7 |
| **Codacy** | GitHub App; analysis on push/PR; AI Reviewer per PR (GitHub only) | PR summary + issue annotations | yes — Opengrep, Trivy, jscpd, Lizard on `.rs`/`.rlib` | Developer **$0** (IDE only); Team from **$18 USD/dev/mo** annual, ≤100 private repos | no on free (free-forever is open source) | cloud; GHES + data residency on Business | many static tools + LLM AI Reviewer | 8 |
| **Graphite (AI reviews)** | GitHub App; enable per repo; reviews new PRs automatically | yes | not enumerated anywhere in docs | Hobby **free** (limited AI reviews, personal repos); Starter **$20 USD/user/mo** annual; Team **$40** annual for unlimited AI reviews | Hobby covers personal repos; org repos need Starter+ | SaaS; GHES on Enterprise | LLM + Graphite Agent with codebase context | 9 |
| **Ellipsis** | GitHub App + `.ellipsis/code-review.yaml`; one review per push | yes; per-reviewer approve / request-changes | not enumerated (runs Claude Code / Codex sessions) | tokens **+10%** platform fee, $0/seat; CPU $0.142/vCPU-hr, RAM $0.024/GB-hr; free tier not stated on page | yes — the GitHub handler defaults `private: {users: true, bots: false}`, so private repos are a first-class case (<https://www.ellipsis.dev/docs/integrations/github>) | managed SaaS or your own AWS account | agent sessions over a checked-out repo, not static analysis | 10 |
| **Cursor Bugbot** | automatic on every PR update; `cursor review` / `bugbot run`; API (Enterprise) | yes, with `Cursor Bugbot` check | not enumerated | no separate subscription; usage-based, avg review **$1.00–$1.50**; AI reviews included from Premium **$30 USD/mo** | yes | SaaS | LLM (frontier + in-house), reads existing PR comments as context | 11 |
| **Qodana** | GitHub Actions / GitLab CI / Jenkins / TeamCity job with `pr-mode` | yes — `post-pr-comment` and `use-annotations` both default true in the action | yes — `qodana-rust`, Ultimate/Ultimate Plus only | Community **free** (no Rust); Ultimate **$5 USD/contributor/mo** yearly ($60/yr) or **$6** monthly; Ultimate Plus **$15/$18**; **min 3** contributors, so the floor is $15/mo | unlimited private repos listed even for Community | CI (Docker) + Qodana Cloud | IDE inspections (RustRover) | 12 |

## Qualifiers

### 1. Greptile

The only vendor here whose *free* tier is described in repo terms rather than user terms for a single
developer: Starter is "Unlimited repositories / 50 credits per month / 1 active developer"
(<https://www.greptile.com/pricing>). A `Base` review costs 1 credit, `Plus` 3, `Apex` 10, so 50 credits
is 50 base reviews a month; Pro is "$30/seat/month" including 50 credits per seat, then "$1 per additional
credit", and a seat is "any developer who has gotten a review done by Greptile in that billing period"
(<https://www.greptile.com/docs/code-review-bot/billing-seats>).

| | |
|---|---|
| Trigger | GitHub App install, then enable repos; auto-review on open / push / rebase is configurable (Never → all events), plus `@greptileai` manual trigger (<https://www.greptile.com/docs/quickstart>) |
| Inline | Findings land as PR comments "in ~3 minutes" with suggested fixes and a `Fix with your Agent` button (<https://www.greptile.com/docs/introduction>) |
| Languages | "**All languages supported** — Greptile works with any programming language in your codebase" (<https://www.greptile.com/docs/introduction>) |
| Analysis | "builds a graph of your entire repository (functions, classes, imports, dependencies)" and reasons beyond the diff; optional T-Rex sandbox runs the change (<https://www.greptile.com/docs/code-review/key-features>) |
| Deployment | Cloud (SOC2 Type II), Docker Compose, Kubernetes/Helm, air-gapped; self-hosted needs a licence and your own LLM keys (<https://www.greptile.com/docs/deployment-options>) |
| Status | Changelog entry 2026-09-25 adds Base/Plus/Apex/Auto review tiers (<https://www.greptile.com/docs/changelog>) |

Caveat that matters at this repo's size: credits are **per author, not pooled** — "Overages are per-author,
not pooled across the team" (<https://www.greptile.com/docs/code-review-bot/billing-seats>). One active
developer means the free 50 credits are that developer's 50. Starter's "Unlimited repositories" is stated
without a visibility qualifier, but no Greptile page read says "private" and "free" in the same sentence —
that eligibility is an inference from the absence of a public-only term, not a quoted promise.

### 2. GitHub Copilot code review

The cheapest paid path *and* the least integration work, but read the plan table carefully: Copilot Free
"does not include Copilot code review", so the floor for an individual is Copilot Pro at $10 USD per month
with 1,500 total monthly AI credits (<https://docs.github.com/en/copilot/get-started/plans>,
<https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review>).

| | |
|---|---|
| Trigger | Assign Copilot as reviewer on the PR ("usually takes less than 30 seconds"), or configure automatic reviews per user / repo / org; REST API accepts `copilot-pull-request-reviewer[bot]` (<https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review>) |
| Inline | yes — severity High/Medium/Low, suggested changes applied in one click; by default it posts a **Comment** review, not an approval (<https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review>) |
| Languages | "Copilot code review reviews code written in any language" (<https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review>) |
| Cost shape | per-review AI-credit estimates: "$0.05 USD to $1 USD … with 'Lite' effort, and $0.25 USD to $5 USD … with 'Balanced' effort", **plus** Actions minutes for the agentic pass (<https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review>) |
| Analysis | LLM + "Full project context gathering … analyzes your entire repository"; can use repo agent skills and MCP servers (<https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review>) |
| Deployment | GitHub.com, GitHub CLI, Mobile, VS Code, Visual Studio, Xcode, JetBrains, Azure DevOps (preview); "Copilot is not currently available for GitHub Enterprise Server" (<https://docs.github.com/en/copilot/get-started/plans>) |
| Status | changelog "Copilot code review: New organization billing options and controls", 2026-10-08 (<https://github.blog/changelog/>) |

Note for a repo that squash-merges: Copilot "will only review a pull request once" unless "Review new
pushes" is enabled — re-reviews then need the re-request button
(<https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review>).

### 3. SonarQube Cloud (AI Code Assurance / AI CodeFix)

The free tier is real but narrow: "SonarQube Team Plan, free for your private projects up to 50k LOC"
(<https://www.sonarsource.com/plans-and-pricing/>), and the plan table confirms Free allows "Up to 50k LOC"
private analysis with **5** organization members, while pull-request analysis on Free is "Only if the
target branch is the main branch"
(<https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans.md>).
For a `branch → PR → main` workflow that restriction is satisfied.

| | |
|---|---|
| Trigger | automatic analysis on PR creation and every push (GitHub, GitLab, Azure DevOps); or build analysis in CI (<https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis.md>) |
| Inline | "depending on your platform, issues may be reported as inline annotations"; the summary "can block the merge of the pull request if the quality gate fails" (<https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis.md>) |
| Rust | checked in all three columns of the language table — Community Build, Cloud, and Server 2026.5 (<https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/languages/overview.md>) |
| Analysis | deterministic rule engine on new code only ("only issues that appear in B … not in T are reported"), plus AI CodeFix for fixes (<https://docs.sonarsource.com/agent-centric-development-cycle/in-your-long-living-branches-the-code-maintenance-loop/ai-codefix.md>) |
| AI Code Assurance | labels + default quality gate + badges for AI-generated projects; available on Free, Team and Enterprise in Cloud (<https://docs.sonarsource.com/agent-centric-development-cycle/ai-code-standards/ai-code-assurance.md>) |
| AI CodeFix plan | Cloud Team and Enterprise; Server Enterprise/Data Center. Self-hosted "is designed to operate without outbound internet access" (<https://docs.sonarsource.com/agent-centric-development-cycle/in-your-long-living-branches-the-code-maintenance-loop/ai-codefix.md>) |
| Status | SonarQube Server 2026.5 is the current documented release (<https://docs.sonarsource.com/sonarqube-server>) |

Sonar now sells a separate AI reviewer, **Gitar** ($20 USD/user/mo billed annually, "Unlimited public and
private repos"), and the SonarQube Cloud PR docs explicitly point at it for "AI-powered review comments
directly in pull requests" — i.e. Sonar itself treats SonarQube's PR analysis and AI review comments as two
products (<https://www.sonarsource.com/plans-and-pricing/>,
<https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis.md>).

### 4. Semgrep (Semgrep Code + Multimodal, formerly Assistant)

Cheapest way to get *Rust-aware* automated review on a private repo: Free Edition is $0 with "Scan up to 10
repositories", "Maximum 10 contributors" and "60 AI credits included", and the plan table lists private
repos "10 max" for Free (<https://semgrep.dev/pricing/>).

| | |
|---|---|
| Trigger | Semgrep AppSec Platform + `semgrep ci` in CI; diff-aware PR/MR scans; Managed Scans; PR comments on all supported SCMs (<https://docs.semgrep.dev/getting-started/scm-support>) |
| Inline | PR/MR comments carry Multimodal explanations and remediation guidance; inline MR comments for agentic workflows need GitLab ≥16.5 (<https://docs.semgrep.dev/semgrep-multimodal/overview>, <https://docs.semgrep.dev/getting-started/scm-support>) |
| Rust | "**Generally available** • Cross-function dataflow analysis • 40+ Pro rules"; Supply Chain adds reachability and malicious-dependency detection for Rust (<https://docs.semgrep.dev/supported-languages>) |
| Analysis | rule-based SAST (patterns + dataflow, cross-file on the Pro engine) with LLM layered on for detection, autotriage, explanation and suggested fixes — "Semgrep is not a scanner + chatbot; Multimodal primarily supports findings generated by Semgrep Code" (<https://docs.semgrep.dev/semgrep-multimodal/overview>, <https://docs.semgrep.dev/semgrep-code/overview>) |
| Scope limit | "AI-powered detection does not support diff-aware scans"; diff-aware scans auto-analyze "Up to 10 new findings" per scan (<https://docs.semgrep.dev/semgrep-multimodal/overview>) |
| Private code | "If Semgrep runs either locally or fully in your CI pipeline, then no, your source code never leaves your computer or your CI environment" (<https://semgrep.dev/pricing/>) |
| Status | release v1.181.0, 2026-10-14 (<https://github.com/semgrep/semgrep/releases.atom>) |

### 5. CodeScene

The strongest *Rust-specific* evidence of the paid tools: Rust is "Full support" and "X-Ray (method level
hotspots)", and CodeScene documents a Rust-only `content_filter: test_code` rule so unit tests embedded in
`.rs` files can be held to looser Code Health rules than the application code
(<https://codescene.io/docs/usage/language-support.html>).

| | |
|---|---|
| Trigger | webhooks created by CodeScene; "reviews any opened or modified Pull/Merge Requests"; GitHub, Bitbucket, GitLab, Azure, Gerrit (on-prem only) (<https://codescene.io/docs/guides/pr-integration/integrate-into-ci-cd.html>) |
| Inline | PR check plus findings; individual findings can be suppressed per PR; quality profiles (`Bare Minimum`, `Clean Code Collective`, `Pay down tech debt`, custom) decide what fails (<https://codescene.io/docs/guides/pr-integration/integrate-into-ci-cd.html>) |
| Config as code | `.codescene/custom-quality-gates.json` at repo root, with `matching_content_path` / `matching_team` per rule set; the PR review reads the file **from the branch** (<https://codescene.io/docs/guides/pr-integration/integrate-into-ci-cd.html>) |
| Analysis | deterministic Code Health metric — no LLM in the gate; the separate PR Refactoring Agent and MCP server are add-ons (<https://codescene.com/product/automated-code-health-reviews>, <https://codescene.com/pricing>) |
| Price | Standard **€18** per active author/month billed yearly, Pro **€27**; "Unlimited private repositories" in both; a free Community Edition exists for open source (<https://codescene.com/pricing>) |
| Deployment | "On-prem (self managed)" and "Cloud-based" on every tier (<https://codescene.com/pricing>) |
| Status | Release Notes 7.5.15, 2026-10-14 (<https://community.codescene.com/changelog>) |

### 6. Bito

The only vendor in this list that states Rust support for the **AI review** path explicitly — "Rust: YES /
YES / YES" for AI Code Review, Basic and Advanced Code Understanding — while its static-analysis table says
Rust gets no linter and no OSS vulnerability check
(<https://docs.bito.ai/ai-code-reviews-in-git/supported-programming-languages-and-tools.md>).

| | |
|---|---|
| Trigger | GitHub App (Bito Cloud) or self-hosted webhooks service; GitHub Actions; CLI for one-off reviews; auto on PR (<https://docs.bito.ai/ai-code-reviews-in-git/overview.md>, <https://docs.bito.ai/sitemap.md>) |
| Inline | "automatically posting recommendations directly as comments within the corresponding Pull Request" (<https://docs.bito.ai/ai-code-reviews-in-git/overview.md>) |
| Analysis | LLM plus "Symbol Indexing, Abstract Syntax Trees (AST), and Embeddings" for whole-repo context; optional Infer / ESLint / golangci-lint / Ruff / mypy / Snyk findings (<https://docs.bito.ai/ai-code-reviews-in-git/overview.md>) |
| Price | Team **$12/seat/mo** annual ($15 monthly) with "5K lines/seat/month included, $5 per 1K after"; Professional **$20** annual ($25 monthly); self-hosted is a "$5/seat/month add-on" on Professional (<https://bito.ai/pricing/>) |
| Free plan | "The **Free Plan** offers **AI-generated pull request summaries**"; line-level suggestions need Team (<https://docs.bito.ai/ai-code-reviews-in-git/overview.md>) |
| Data | "Bito neither reads nor stores your code, and none of your code is used for AI model training"; SOC 2 Type II (<https://docs.bito.ai/ai-code-reviews-in-git/overview.md>, <https://bito.ai/pricing/>) |
| Status | changelog entry 18 Sep 2026 (Governor auto-routing); AI Code Review Agent entries through 11 Feb 2026 (<https://docs.bito.ai/changelog.md>) |

### 7. DeepSource

Rust is a first-class analyzer, not just an LLM pass: "Rust | ≤1.93 | GA" in the analyzer table, and SCA
runs on `Cargo.lock` including workspace-style monorepos
(<https://docs.deepsource.com/docs/platform/reference/core-analyzers>,
<https://deepsource.com/changelog>).

| | |
|---|---|
| Trigger | GitHub App; static analysis on every PR; AI Review on every PR (or only on `@deepsourcebot` mentions, configurable); CLI v2 (<https://deepsource.com/changelog>) |
| Inline | PR feedback/annotations plus AI Review comments; Autofix for findings (<https://deepsource.com/pricing>) |
| Price | Open Source **$0** — "Public repositories: Unlimited / Private repositories: – / Pull requests reviewed 1,000/month"; Team **$24 per user/month** billed yearly with unlimited private repos and unlimited PR reviews (<https://deepsource.com/pricing>) |
| AI Review billing | "$100 annual credit included per user"; "Standard: $8/10K processed LOC", "Advanced: $15/10K processed LOC" (<https://deepsource.com/pricing>) |
| Deployment | cloud; Enterprise adds self-hosted, BYOK and airgapped (<https://deepsource.com/pricing>) |
| Data | BYOK "Inference calls go directly from your Enterprise Server instance to your chosen provider" (<https://deepsource.com/changelog/2026-03-31>) |
| Status | latest changelog entry 17 Jul 2026 (<https://deepsource.com/changelog>) |

### 8. Codacy

Rust is analysed by third-party engines rather than a Rust-native linter: `Opengrep` for static analysis and
secret detection, `Trivy` for `Cargo.lock` SCA and malicious packages, `jscpd` for duplication, `Lizard` for
complexity (<https://docs.codacy.com/getting-started/supported-languages-and-tools/>).

| | |
|---|---|
| Trigger | GitHub/Bitbucket/GitLab integration; "runs security and other analysis tools when code changes are pushed"; AI Reviewer enabled per repo, then "Run Reviewer" in the PR summary or via public API (<https://docs.codacy.com/getting-started/supported-languages-and-tools/>, <https://docs.codacy.com/codacy-ai/codacy-ai/>) |
| Inline | AI Reviewer "will start adding a Summary to your pull requests based on the AI-enriched reviews"; issue annotations via the GitHub integration (<https://docs.codacy.com/codacy-ai/codacy-ai/>) |
| Price | Developer **$0** (IDE plugin only); Team "Starting at **$18** Per dev/mth" annual / "$21" monthly, "Up to 100 private repos & unlimited LOC"; Business custom (<https://www.codacy.com/pricing>) |
| AI Reviewer availability | "currently only available on GitHub, for all Team and Business plans", opt-in, OpenAI models via Amazon Bedrock (<https://docs.codacy.com/codacy-ai/codacy-ai/>) |
| Data | "Customer Code processed through Codacy AI will not be used … for training"; secrets redacted before sending (<https://docs.codacy.com/codacy-ai/codacy-ai/>) |
| Deployment | cloud; "GitHub Enterprise with Data Residency" on Business (<https://www.codacy.com/pricing>) |
| Status | docs commit 2026-10-16 — AI Reviewer moved to OpenAI `gpt-5.6-luna` via Bedrock and now posts a "too large" review above 270k tokens of context (<https://github.com/codacy/docs/commits.atom>) |

### 9. Graphite (AI reviews, formerly the Diamond agent)

Graphite's free Hobby tier includes "Limited AI reviews" and "Personal account repos support", which is what
makes it relevant to a personal GitHub account; org repos need Starter, and only Team lists "Unlimited AI
Reviews" (<https://graphite.com/pricing>, <https://graphite.com/docs/billing-plans>).

| | |
|---|---|
| Trigger | GitHub App; enable AI reviews per repo or org-wide, then "Graphite Agent will now automatically review all new pull requests in the selected repositories" (<https://graphite.com/docs/ai-reviews-setup>) |
| Inline | "Comments directly on pull requests when it finds potential issues" and "Suggests fixes" (<https://graphite.com/docs/ai-reviews-setup>) |
| Languages | no language list is published on the AI review pages read; reviews are LLM-based over the codebase (<https://graphite.com/docs/ai-reviews>) |
| Price | Starter **$20/seat/mo** billed annually, Team **$40/seat/mo** billed annually, Hobby free; both paid tiers show "Limited" vs "Unlimited" PR reviews, and review customisation + suggested fixes are Team-only (<https://graphite.com/docs/billing-plans>) |
| Data | AI features are opt-in, "Neither Graphite nor any of its subprocessors use your data to train their models", and all AI can be blocked org-wide on request (<https://graphite.com/docs/ai-privacy-and-security>) |
| Deployment | SaaS; "GHES support" is Enterprise-only (<https://graphite.com/pricing>) |
| Status | `@withgraphite/graphite-cli` 1.8.6 on npm; CLI changelog top entry 2026-05-04 (<https://registry.npmjs.org/@withgraphite/graphite-cli/latest>, <https://graphite.com/docs/cli-changelog>) |

Rename note, for the record: the docs and pricing pages now say "Graphite Agent" / "AI reviews"; no page
read still calls the reviewer "Diamond" (<https://graphite.com/docs/ai-reviews>).

### 10. Ellipsis

The only pricing model here with no seat: "$0 per-seat fees", tokens at cost plus a 10% platform fee, and a
BYOC option that runs in your own AWS account
(<https://www.ellipsis.dev/pricing>). That makes it cheap for one developer and dangerous for a chatty
push-per-commit workflow — every admitted push starts reviewer sessions.

| | |
|---|---|
| Trigger | GitHub App plus a `kind: code_review` file at `.ellipsis/code-review.yaml`; "Each push the file admits gets at most one review"; draft handling and path filters per reviewer (<https://www.ellipsis.dev/docs/code-review>) |
| Inline | comments land "with their comments" from `ellipsis-dev[bot]`; `on_pass`/`on_fail` can be `approve`, `request_changes`, `comment` or `silent` (<https://www.ellipsis.dev/docs/code-review>) |
| Limits | "A review posts at most 64 comments, and each reviewer returns at most 64"; a reviewer over budget "contributes nothing, and that reviewer covers the same commits again on the next push" (<https://www.ellipsis.dev/docs/code-review>) |
| Price | tokens at cost + "10% of token cost"; CPU "**$0.142 / vCPU-hour**", memory "**$0.024 / GB-hour**"; support packages $5k–$15k/month, not required (<https://www.ellipsis.dev/pricing>) |
| Free tier | the page's FAQ includes "Is it free for open source?" but the answer did not render; no free tier is stated — [UNVERIFIED] (<https://www.ellipsis.dev/pricing>) |
| Analysis | agent sessions (Claude Code or Codex harness) in a YAML-defined environment with repo checkout, skills and per-session USD budget — not a static analyzer (<https://www.ellipsis.dev/docs/agents/schema>) |
| Deployment | managed SaaS, or "Deploys into your AWS VPC. No credentials, code, or LLM calls leave it" (<https://www.ellipsis.dev/pricing>) |
| Status | CLI v2.39.0, 2026-10-13 (<https://github.com/ellipsis-dev/cli/releases.atom>) |

### 11. Cursor Bugbot

Priced per review rather than per seat, and included in the Cursor Premium plan's feature table as "AI code
reviews via Bugbot" (<https://cursor.com/pricing>). Its docs publish a `neutral` default conclusion, so a
required `Cursor Bugbot` check will not block merges on findings unless fail-on-unresolved is enabled
(<https://cursor.com/docs/bugbot>).

| | |
|---|---|
| Trigger | "Runs **automatic reviews** on every PR update"; manual `cursor review` or `bugbot run`; API `POST /bugbot/review` (Enterprise, 30 req/min) (<https://cursor.com/docs/bugbot>) |
| Inline | "analyzes PR diffs and leaves comments with explanations and fix suggestions"; check named `Cursor Bugbot` (<https://cursor.com/docs/bugbot>) |
| Context | "Uses existing PR comments as context: reads connected PR comments (top-level and inline) to avoid duplicate suggestions" (<https://cursor.com/docs/bugbot>) |
| Languages | no language list published; "uses a combination of frontier and in-house models to review code" (<https://cursor.com/bugbot>) |
| Price | "Bugbot is usage-based on Individual and Teams plans, so there's no separate Bugbot subscription… The average review costs **$1.00–$1.50**" (<https://cursor.com/bugbot>); Premium **$30 USD/month** lists AI code reviews (<https://cursor.com/pricing>) |
| Data | "Privacy mode … code data is not used for training by us or our model providers" (<https://cursor.com/pricing>) |
| Deployment | SaaS; works with GitHub (incl. GHES), GitLab (incl. self-hosted), Bitbucket, Azure DevOps (<https://cursor.com/docs/bugbot>) |
| Status | docs current; Cursor changelog latest entry 2026-10-16 (<https://cursor.com/changelog>) |

### 12. Qodana

Included because it is the JetBrains answer and has a real Rust linter — but the licence structure makes it a
poor fit for a one-developer repo: `qodana-rust` is "Available under licenses: Ultimate and Ultimate Plus",
and "The minimal number of contributors used for licensing is three (3)" with "The total license cost …
based on the number of active contributors"
(<https://www.jetbrains.com/help/qodana/rust.html>, <https://www.jetbrains.com/help/qodana/pricing.html>).
At the measured commercial rates that minimum makes the monthly floor **$15 USD** (yearly) or **$18 USD**
(monthly) before a single line of Rust is analyzed.

| | |
|---|---|
| Trigger | CI job — GitHub Actions (native), GitLab CI, Azure Pipelines, CircleCI, TeamCity; Docker image for Jenkins/Bitbucket; `pr-mode` reports only new issues (<https://www.jetbrains.com/help/qodana/ci.html>, <https://github.com/JetBrains/qodana-action>) |
| Inline | GitHub Action posts results: `post-pr-comment` (default `true`) and `use-annotations` (default `true`); the alternative is SARIF into GitHub code scanning, which you wire up yourself (<https://github.com/JetBrains/qodana-action>) |
| Rust | `qodana-rust` based on RustRover, shipped as `jetbrains/qodana-rust:2026.2-eap` (<https://www.jetbrains.com/help/qodana/rust.html>) |
| Price | Community free. Ultimate **$6 USD/contributor/mo** monthly, **$5/mo** billed yearly ($60/yr); Ultimate Plus **$18/mo** monthly, **$15/mo** billed yearly ($180/yr) — read from the buy page's own `productsData` payload, commercial tier, US store. Billing unit is active contributors with **minimum 3**, so the floor is $15/mo yearly / $18/mo monthly (<https://www.jetbrains.com/qodana/buy/>, <https://www.jetbrains.com/help/qodana/pricing.html>) |
| Private repos | "Private repositories: Unlimited" for all three licences, including Community (<https://www.jetbrains.com/help/qodana/pricing.html>) |
| Analysis | IDE inspections from RustRover; baseline + quality gate; `--apply-fixes` can push a fix branch or PR (<https://www.jetbrains.com/help/qodana/rust.html>, <https://github.com/JetBrains/qodana-action>) |
| Status | `qodana-action` v2026.2.2 released 2026-09-29; docs build 2026-10-16 (<https://github.com/JetBrains/qodana-action/releases.atom>, <https://www.jetbrains.com/help/qodana/linters.html>) |

## Checked and dropped, with the reason

Every name below was on the candidate list; each fails the "reviews PRs automatically, still available,
first-party docs today" test for a stated reason.

- **Amazon CodeGuru Reviewer** — effectively closed: "As of November 7, 2025, you can't create new repository
  associations", and it only covers "your Java and Python code"
  (<https://docs.aws.amazon.com/codeguru/latest/reviewer-ug/welcome.html>). Fails availability and Rust.
- **Sourcegraph (Cody, Amp)** — Cody is chat/auto-edit/completions in the IDE with no automatic PR review
  described (<https://sourcegraph.com/docs/cody>); Amp's docs index lists orbs, threads, CLI and Puck but no
  PR-review surface (<https://ampcode.com/docs>). Fails "reviews pull requests automatically".
- **Snyk Code** — Rust code analysis exists but is gated: "Code analysis support for Rust is in Early Access
  and is available only with Enterprise plans", and for Rust "SCM import and the standard CLI commands
  `snyk test`, `snyk monitor` are not available"
  (<https://docs.snyk.io/supported-languages/supported-languages-list/rust.md>). Fails private-repo PR
  review on Rust at a usable tier.
- **Pixee** — deliberately not a reviewer: "Pixee is not a scanner. It works downstream of your existing
  SAST, SCA, and DAST tools", and "Without at least one connected scanner, there is nothing for Pixee to act
  on" (<https://docs.pixee.ai/>). Fails "reviews diffs automatically" — it opens fix PRs from other tools'
  findings.
- **Sweep** — the repo now says "We're now building an AI coding assistant for JetBrains" and the README
  documents no PR-review product (<https://github.com/sweepai/sweep>). Fails "currently available as a
  reviewer".
- **Codiga** — shut down: "On **May 4th**, all Codiga products (including the IDE plugin, command-line tool,
  and Git integration) will shut down" after the Datadog acquisition
  (<https://www.codiga.io/blog/codiga-joins-datadog/>). Fails availability.
- **PullRequest.com** — now HackerOne Code, described as AI filtering plus "expert engineers manually review
  and validate each finding"; no self-serve pricing or free tier is published
  (<https://www.pullrequest.com/>). Fails the "first-party docs + reachable today" bar on pricing, and it is a
  human-led service rather than an installable reviewer.
- **Qodo Merge itself** — not dropped, but renamed: the docs state "The current product is Qodo Review (v2)"
  with historical names "Qodo Merge, PR-Agent, Qodo Gen, Codiumate", and it has no permanent free tier
  ("We don't offer a permanent free tier") (<https://docs.qodo.ai/llms.txt>,
  <https://www.qodo.ai/pricing/>). Relevant because the known three are now priced as $0.012/credit pooled,
  starting with a 2,500-credit pack.

## Why three at once didn't stick

Grounded strictly in what the three vendors document about themselves — no inference about anyone's
experience.

**They overlap on the same four outputs.** Sourcery says "every review posts the same things": a summary in
the PR description, a reviewer's-guide comment, inline comments with one-click apply, and a **Sourcery
review** status check that "can gate merges"
(<https://docs.sourcery.ai/reviews/>). CodeRabbit posts a summary into the PR description, a walkthrough
comment "separate from inline code comments", inline findings, and Pre-Merge Checks
(<https://docs.coderabbit.ai/pr-reviews/summaries.md>, <https://docs.coderabbit.ai/pr-reviews/walkthroughs.md>,
<https://docs.coderabbit.ai/pr-reviews/pre-merge-checks.md>). Qodo posts findings "published directly on your
pull request", each ranked by severity, plus a PR summary and severity thresholds
(<https://docs.qodo.ai/code-review>). Three GitHub Apps on one PR therefore produce three independent
comment sets for the same event, and nothing in any of the three docs coordinates with the other two.

**They overlap on "not just the diff".** Qodo states it plainly — "Most review tools only look at the diff.
Qodo reviews every pull request (PR) … with specialized AI agents that understand your full repository"
(<https://docs.qodo.ai/code-review>) — and separately that it "analyzes the full repository, not just the
changed lines" (<https://docs.qodo.ai/code-review/overview>). CodeRabbit's Knowledge Base covers learnings,
code-guideline files, multi-repo analysis and MCP servers
(<https://docs.coderabbit.ai/knowledge-base/index.md>). Sourcery's reviewer's guide "maps the change set
file by file and explains how to verify it" on every review
(<https://docs.sourcery.ai/reviews/>). All three are whole-repo LLM reviewers; none has a deterministic
Rust analyzer behind it.

**They overlap on per-seat SaaS pricing with asymmetric free tiers.** Sourcery: free for public repos, Pro
$12–15/developer/month for private repos (<https://www.sourcery.ai/pricing>). CodeRabbit: Free plan is
"PR summarization only", Essentials $24/user/month annual (<https://docs.coderabbit.ai/management/plans.md>).
Qodo: no permanent free tier, credit-metered at $0.012/credit
(<https://www.qodo.ai/pricing/>). That asymmetry is the concrete reason a stack of three is expensive rather
than additive: on a private repo, the cheapest of the three still charges per seat, the middle one is a
free tier that only summarizes, and the last one is metered — and all three bill for the same PR.

## Sources

Primary pages read 2026-10-18 (pricing figures on this same date):

- Greptile: <https://www.greptile.com/pricing> · <https://www.greptile.com/docs/introduction> ·
  <https://www.greptile.com/docs/quickstart> · <https://www.greptile.com/docs/code-review/key-features> ·
  <https://www.greptile.com/docs/code-review-bot/billing-seats> ·
  <https://www.greptile.com/docs/deployment-options> · <https://www.greptile.com/docs/changelog>
- GitHub Copilot code review:
  <https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review> ·
  <https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review> ·
  <https://docs.github.com/en/copilot/get-started/plans> · <https://github.blog/changelog/>
- SonarQube: <https://www.sonarsource.com/plans-and-pricing/> ·
  <https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis.md> ·
  <https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans.md> ·
  <https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/languages/overview.md> ·
  <https://docs.sonarsource.com/sonarqube-server> ·
  <https://docs.sonarsource.com/agent-centric-development-cycle/ai-code-standards/ai-code-assurance.md> ·
  <https://docs.sonarsource.com/agent-centric-development-cycle/in-your-long-living-branches-the-code-maintenance-loop/ai-codefix.md> ·
  <https://www.sonarsource.com/products/gitar/>
- Semgrep: <https://semgrep.dev/pricing/> · <https://docs.semgrep.dev/supported-languages> ·
  <https://docs.semgrep.dev/semgrep-multimodal/overview> · <https://docs.semgrep.dev/semgrep-code/overview> ·
  <https://docs.semgrep.dev/getting-started/scm-support> ·
  <https://github.com/semgrep/semgrep/releases.atom>
- CodeScene: <https://codescene.com/pricing> ·
  <https://codescene.com/product/automated-code-health-reviews> ·
  <https://codescene.io/docs/guides/pr-integration/integrate-into-ci-cd.html> ·
  <https://codescene.io/docs/usage/language-support.html> · <https://community.codescene.com/changelog>
- Bito: <https://bito.ai/pricing/> · <https://docs.bito.ai/ai-code-reviews-in-git/overview.md> ·
  <https://docs.bito.ai/ai-code-reviews-in-git/supported-programming-languages-and-tools.md> ·
  <https://docs.bito.ai/sitemap.md> · <https://docs.bito.ai/changelog.md>
- DeepSource: <https://deepsource.com/pricing> · <https://deepsource.com/changelog> ·
  <https://docs.deepsource.com/docs/platform/reference/core-analyzers> ·
  <https://deepsource.com/changelog/2026-03-31>
- Codacy: <https://www.codacy.com/pricing> · <https://www.codacy.com/ai-reviewer> ·
  <https://docs.codacy.com/codacy-ai/codacy-ai/> ·
  <https://docs.codacy.com/getting-started/supported-languages-and-tools/> ·
  <https://github.com/codacy/docs/commits.atom>
- Graphite: <https://graphite.com/pricing> · <https://graphite.com/docs/billing-plans> ·
  <https://graphite.com/docs/ai-reviews> · <https://graphite.com/docs/ai-reviews-setup> ·
  <https://graphite.com/docs/ai-privacy-and-security> · <https://graphite.com/docs/cli-changelog> ·
  <https://registry.npmjs.org/@withgraphite/graphite-cli/latest>
- Ellipsis: <https://www.ellipsis.dev/pricing> · <https://www.ellipsis.dev/docs/code-review> ·
  <https://www.ellipsis.dev/docs/agents/schema> · <https://www.ellipsis.dev/docs/quick-start> ·
  <https://github.com/ellipsis-dev/cli/releases.atom>
- Cursor Bugbot: <https://cursor.com/docs/bugbot> · <https://cursor.com/bugbot> ·
  <https://cursor.com/pricing> · <https://cursor.com/changelog>
- Qodana: <https://www.jetbrains.com/help/qodana/rust.html> ·
  <https://www.jetbrains.com/help/qodana/pricing.html> · <https://www.jetbrains.com/help/qodana/linters.html> ·
  <https://www.jetbrains.com/help/qodana/ci.html> · <https://www.jetbrains.com/qodana/buy/> ·
  <https://github.com/JetBrains/qodana-action> ·
  <https://github.com/JetBrains/qodana-action/releases.atom>
- Dropped candidates: <https://docs.aws.amazon.com/codeguru/latest/reviewer-ug/welcome.html> ·
  <https://sourcegraph.com/docs/cody> · <https://ampcode.com/docs> ·
  <https://docs.snyk.io/supported-languages/supported-languages-list/rust.md> · <https://docs.pixee.ai/> ·
  <https://github.com/sweepai/sweep> · <https://www.codiga.io/blog/codiga-joins-datadog/> ·
  <https://www.pullrequest.com/>
- Known three, for the overlap section: <https://docs.sourcery.ai/reviews/> ·
  <https://www.sourcery.ai/pricing> · <https://docs.coderabbit.ai/management/plans.md> ·
  <https://docs.coderabbit.ai/pr-reviews/summaries.md> · <https://docs.coderabbit.ai/pr-reviews/walkthroughs.md> ·
  <https://docs.coderabbit.ai/pr-reviews/pre-merge-checks.md> ·
  <https://docs.coderabbit.ai/knowledge-base/index.md> · <https://docs.qodo.ai/code-review> ·
  <https://docs.qodo.ai/code-review/overview> · <https://docs.qodo.ai/llms.txt> ·
  <https://www.qodo.ai/pricing/>

Not verifiable on 2026-10-18, and marked as such above:

- **Ellipsis free tier.** <https://www.ellipsis.dev/pricing> lists an "Is it free for open source?" FAQ entry
  whose answer did not render; no free tier is stated anywhere on the page read.

Resolved after the first draft:

- **Qodana Ultimate / Ultimate Plus per-contributor price.** The figures were in the buy page after all, in
  its embedded `productsData` JSON (`QDU`, `QDUP` → `prices.commercial`), not in the rendered text: Ultimate
  $5/mo yearly ($60/yr) or $6/mo monthly, Ultimate Plus $15/mo yearly ($180/yr) or $18/mo monthly
  (<https://www.jetbrains.com/qodana/buy/>).
