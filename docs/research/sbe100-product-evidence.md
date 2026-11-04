# Chief of Staff: product evidence for an SBE100 business concept

Research date: November 1, 2026. Source revision: `821558e54c7d94b4f267fe4076b014d5a9027f80`. This note separates the existing software from a proposed business around it. It establishes no organizational affiliation, customer traction or commercial commitment.

## Existing product

Chief of Staff is documented as a local, single-user application with five connected areas: meetings, content creation, content research, person profiles and tasks. Its workspace uses SQLite and server-rendered HTML. The product can prepare meeting briefs, associate transcripts, produce evidence-linked debriefs and action proposals, manage content projects through reviewed outlines and drafts, research people or subjects, and organize local tasks. These are product capabilities, not evidence of customer outcomes. See [README.md, lines 3–15](../../README.md#L3-L15).

The supported installation is Docker. Compose exposes the app on loopback (`127.0.0.1:5317:5317`) and mounts a persistent workspace volume; SearXNG and Valkey are additional services. This supports a customer-local installation concept. It does not establish a hosted, multi-tenant SaaS offering. See [docker-compose.yml, lines 3–10, 45–71](../../docker-compose.yml#L3-L71) and [README.md, lines 69–91](../../README.md#L69-L91).

Review is part of the workflow. Meeting actions require explicit capture and acceptance into Tasks; Gmail creates a reviewed draft addressed to the connected account, and the app has no mail-send operation. See [README.md, lines 179–183](../../README.md#L179-L183) and [lines 253–258](../../README.md#L253-L258). Content evidence must be reviewed before outline or draft generation; draft generation requires an approved outline, and export requires approval of the current draft for that outline. These checks appear in [content/routes.rs, lines 446–454](../../crates/app/src/content/routes.rs#L446-L454) and [lines 555–564](../../crates/app/src/content/routes.rs#L555-L564).

Google Calendar intake, Drive/Docs transcript intake, reviewed Gmail drafts, optional Google Tasks/Asana delivery, HubSpot evidence capture and YouTube observations are documented integrations. Google integration requires customer configuration and connection. See [README.md, lines 11–15](../../README.md#L11-L15) and [lines 229–258](../../README.md#L229-L258). This research did not connect or validate any real customer account.

Credentials remain installation configuration. Live model calls bill the selected account; missing credentials leave affected operations unavailable. Local records and editing can work without an account, but that is not a claim that AI generation or public research is fully offline or free. See [README.md, lines 57–67](../../README.md#L57-L67) and [lines 87–91](../../README.md#L87-L91). Compose exposes separate installation variables for generation, Jev/OpenRouter, Google, Asana, YouTube and HubSpot in [docker-compose.yml, lines 16–45](../../docker-compose.yml#L16-L45).

## Direct evidence excerpts and test coverage

The excerpts below are verbatim repository text at the source revision above.

| Evidence | Excerpt | What it supports |
| --- | --- | --- |
| [README.md:3](../../README.md#L3) | “A local, single-user Chief of Staff” | Local, individual deployment posture. |
| [docker-compose.yml:6](../../docker-compose.yml#L6) | `- "127.0.0.1:5317:5317"` | Loopback host port binding. |
| [docker-compose.yml:49](../../docker-compose.yml#L49) | `- workspace:/data/workspace` | Persistent workspace mount. |
| [content/routes.rs:453](../../crates/app/src/content/routes.rs#L453) | “Approve the latest outline before generating a draft.” | Explicit outline approval gate. |
| [content/routes.rs:562](../../crates/app/src/content/routes.rs#L562) | “Review and approve the latest draft for the current outline before exporting.” | Export approval and lineage gate. |
| [README.md:63–64](../../README.md#L63-L64) | “Live calls bill the selected account.” | Customer API usage can incur charges. |

Existing tests exercise important contracts. [content.rs, lines 240–278](../../crates/app/tests/content.rs#L240-L278) rejects draft generation before outline approval and export before draft approval, checks Markdown output after approval, then rejects export after a replacement outline. [people_tasks.rs, lines 37–78](../../crates/app/tests/people_tasks.rs#L37-L78) concurrently accepts the same proposal twice, asserts one Task, deletes its source records and checks the Task's retained source context. These are inspected tests, not tests newly run for this note. The repository explains that its ordinary suite uses deterministic providers and Wiremock and that real account verification requires the user's connections: [README.md, lines 337–342](../../README.md#L337-L342).

## Proposed business assumptions

The following are planning assumptions supplied for the SBE100 concept. They are not established by the repository:

- Name: **Chief of Staff**.
- Initial customer hypothesis: solo consultants and founders who need help turning meetings into follow-up work and preparing useful content.
- Initial offer: paid customer-local setup, configuration, onboarding and optional continuing support around the existing app.
- Credential model: customers supply and control their own supported service credentials and pay their provider accounts. A setup engagement helps configure them; credential ownership is not transferred to the business.
- Financing approach: bootstrap with a **$500 startup budget**, treated as a spending ceiling assumption. No allocation, adequacy finding or funding source is established here.

The source-backed reason this offer is plausible is that installation includes Docker, provider credentials, Google API/OAuth configuration and workflow review steps. Offering assistance with that setup is an inference about a possible service, not evidence that anyone will pay for it. See [README.md, lines 69–91](../../README.md#L69-L91) and [lines 229–258](../../README.md#L229-L258).

## Unknowns and claims to avoid

This investigation does not establish pricing, a subscription plan, checkout/payment processing, revenue, paying customers, market size, willingness to pay, measured time savings, customer acquisition cost, support workload, profitability or legal entitlement to commercial redistribution. These need separate validation. A focused exact-string search of README.md, routes.rs and .env.example did not reveal an established pricing/payment offering; this is bounded evidence, not proof of absence throughout the repository.

Avoid claiming that the app autonomously sends follow-up emails, guarantees correct output, replaces human judgment, is entirely offline, includes all provider costs, or is an already validated commercial SaaS. The review and credential boundaries above do not support those claims. A provider model named `beam-free` does not establish the total cost of an installation; Jev, other providers and external services have their own accounts and usage. The product itself notes that evidence-linked outputs do not guarantee extraction recall or correct public-person identity: [README.md, lines 63–67](../../README.md#L63-L67) and [lines 172–183](../../README.md#L172-L183).

## Research method and limits

Read AGENTS.md, README.md, docker-compose.yml, focused application source and relevant existing tests. Behavioral discovery began with `jg` against the explicit `crates/app` root using `--max-requests 8 --max-output-bytes 26000 --concurrency 4`. It ended with `End context.` but reported incomplete discovery (`request-limit` and `resource_limit`) and returned locations without source excerpts; focused direct reads supplied the cited evidence. The configured Jev pin was not changed. No external web research was needed for this repository-grounded product note, and no external pricing or financial recommendation is made.

Six core product claims were checked with `jev_verify` against concise supplied README, Compose and source evidence: six verified, zero contradicted, zero unsupported and zero marked for review; reported confidence ranged from 0.96 to 1.00. The actual evidence remains the cited files. No application code, real integrations, deployment or payment flow was changed or exercised.
