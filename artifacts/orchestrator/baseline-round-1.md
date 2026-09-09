# Orchestrator loop gate — round 1

Fixed point: `8feea68` (`git rev-parse 8feea68` → 8feea68)
Range: `8feea68...HEAD` — 11 commits, 93 files
Patch: `/tmp/orchestrator-diff-1.patch`

## Standards

_No hard violations._

Smells (judgement calls, repo overrides baseline — warnings only):
- Long Method `.github/workflows/canary.yml` — Extract method
- Large Class `apps/server/src/modules/content-scout/host.ts` — Split responsibilities
- Primitive Obsession `packages/shared/src/content-scout.ts` — Value object

_Baseline: Long Method (Extract method), Large Class (Split responsibilities), Feature Envy (Move method to owner), Data Clump (Introduce object), Primitive Obsession (Value object), Long Parameter List (Options object), Divergent Change (Split by reason), Shotgun Surgery (Consolidate site), Lazy Class (Inline or remove), Speculative Generality (Remove abstraction), Message Chains (Hide delegate), Middle Man (Remove delegation) — always judgement calls._

Worst Standards: Long Method — Extract method

## Spec

- **Missing #72** `apps/server/src/modules/content-scout/adapters/youtube.ts` — "At most 50 available top or recent comments collected per item; comment selection to retain meaningful questions and disagreement as well as popular agreement." — caps 30 vs 50 and no question/disagreement ranking (#41 US 49-50 / #52, #58) — see #72
- **Missing #73** `apps/server/src/modules/content-scout/discoverer.ts` — "Discovery based on Brand Profile facts, approved targets, similar domains and categories, related/recommended accounts, public platform searches, citations, mentions, tags, guests, reposts, and outbound links." — similarity factors not domain/category (#41 US 121-122 / #56) — see #73
- **Missing #74** `apps/server/src/modules/content-scout/adapters/*` — "Available adapters to require fixture contracts and repeated live canaries before promotion; failures classified as legitimate empty, blocked, rate-limited, malformed, or unsupported." — fixture coverage simulated not per-adapter files (#41 US 44,129-131 / #59) — see #74
- **Missing #75** `apps/server/src/modules/content-scout/canary.ts` — "LinkedIn initially labeled Coming later, so that Content Scout does not claim an authenticated, discontinued, or unlicensed scraper." — LinkedIn gate persistence disconnect: host.ts reads linkedin-canaries.json never written by ContentScoutCanaryRunner (#41 US 24 / #61) — see #75
- **Wrong #76** `apps/server/src/modules/content-scout/adapters/substack.ts` — "A legitimate empty source distinguished from an inaccessible, blocked, rate-limited, malformed, or unsupported source, so that empty success cannot conceal scraper breakage." — Substack unavailable→failed conflation (#41 US 44 / #50) — see #76
- **Wrong #77** `apps/server/src/modules/content-scout/adapters/youtube.ts` — "Failures classified as legitimate empty, no new material, unsupported capability, blocked access, response-shape change, rate limit, timeout, parser failure, or internal failure." — YouTube causeChain aggregation obscuring unsupported (#41 US 44,130 / #52) — see #77
- **Wrong #78** `apps/server/src/modules/content-scout/adapters/website.ts` — "Feed or plain-HTTP collection tried before browser rendering, so that Content Scout uses the cheapest and most diagnosable route; browser rendering limited to public JS pages that require it." — website empty-shell detection (#41 US 39-40,44 / #49) — see #78

Worst Spec: caps 30 vs 50 and no question/disagreement ranking (#41 US 49-50 / #52, #58) — see #72

---

Standards: 0 hard, 3 smells (worst: Long Method — Extract method); Spec: 4 missing, 3 wrong (worst: caps 30 vs 50 and no question/disagreement ranking (#41 US 49-50 / #52, #58) — see #72); Gate: RED
