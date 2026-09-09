# Person research lead flood — named cause and census (2026-09-08)

Ticket: #239 ("The expanded live arm completes across the collection"), following the
model-sweep diagnosis recorded on that issue. This record quantifies the named cause
against committed run artifacts, the way the extraction-stall diagnosis did for #232.
It names why operations drown; the accompanying change fixes the mechanism.

## Named cause

**The lead queue outruns the pinned per-operation budget.** Discovery materializes
every merged search result as a pending lead while the read batch consumes a fixed
few per round, so the pending pool grows an order of magnitude faster than the
operation can work it. Operations die on their wall-clock backstop with a
four-digit pending queue, and every lead still in it is recorded `interrupted` —
which is why unresolved leads dominated every recorded run.

## Census: run `live-discovery-expanded-004573b4dbe063a6` (30 operations, committed)

| Measure | Value |
| --- | --- |
| Leads materialized | 31,251 |
| Ended `interrupted` | 27,833 (89.1%) |
| Ended `investigated` | 1,579 (5.1%) |
| Ended `inaccessible` / `rejected` | 1,127 / 712 |
| Leads from `discovery` origin | 27,088 (86.7%) |
| Leads from `planner` origin | 3,525 (11.3%) |
| Operations reaching the 900 s wall-clock backstop | 20 of 30 |
| Max model calls spent (ceiling 60) | 37 |
| Max requests spent (ceiling 400) | 316 |

**Lead-generation volume per source family** (the lead's classified family):

| Source family | Leads | Of which `interrupted` |
| --- | ---: | ---: |
| identity-affiliation | 11,407 | 11,225 (98%) |
| documents-publishers | 7,644 | 5,956 (78%) |
| public-social | 3,704 | 3,607 (97%) |
| (no family classified) | 2,039 | 1,199 (59%) |
| creative-records | 1,744 | 1,706 (98%) |
| published-work | 1,612 | 1,507 (94%) |
| spoken-evidence | 1,508 | 1,406 (93%) |
| professional-records | 826 | 780 (94%) |
| historical-evidence | 615 | 446 (73%) |
| general-discovery | 152 | 1 (1%) |

The flood is family-wide, not one provider's: every family the expansion reaches
buries its investigated share under interrupted mass. general-discovery — the one
family whose pages were mostly actually read — is the counterfactual.

**Leads materialized per retained source** — the directive's own ratio: median
32.9 across the 30 operations, worst case 762. The operation paid its discovery
and registration cost for every one of them, then recorded almost all as
`interrupted`.

Conclusions per operation: 0 completed, 20 bounded by the wall-clock backstop, 10
interrupted by the planner-model outage of that window (recorded separately on #239;
the sweep comment of 2026-09-07 20:46 refines those into 8 × prose-under-`response_format`
and 1 × silent-ceiling stall).

**Score separation** (leads carrying a selection score, per operation):

- Read batch (`investigated` URL leads): p10 = **8.4**, median 10.15.
- Deferred-then-interrupted pool: p50 = 5.1, p90 = **6.35**, max 11.7.

The batch's floor sits at or above where the deferred pool's 90th percentile ends:
the ranking already separates work from tail. The near-miss band just below the
floor is thin, which is what makes a margin-based retirement honest — the two
pinned composition scenarios (`record-9` at margin ≈ 0.05, the `/59` registry page
at ≈ 1.65) sit inside a margin of 2 and survive it.

## Why the fix does not cap materialization at the source

The directive names two levers: how many leads discovery materialises per retained
source, and how selection ranks them before a round spends a call. The first lever
is real — 32.9 median — but capping registration by rank re-creates the regression
the repo already removed once: the former eight-result reading cutoff, whose return
two composition tests pin as wrong (`record-9` at merge rank 9 and a registry page
at rank 60 must stay reachable and end `investigated`). A lead's depth in its
query's results is never itself evidence it is irrelevant; the score distribution
above shows the ranking, not the rank, is what separates work from tail. The fix
therefore keeps registration complete and spends the second lever: selection
decides the tail it measurably outranks (ADR-0073), while the near-miss band stays
pending and reachable — depth survives, the queue no longer accumulates.

## Why the budgets never bind on useful work

With `mergedLimit: 60` per query and four queries per round, discovery registers up
to 240 pending leads per round; selection reads at most `2 × readConcurrency` (8)
and the extraction budget allows roughly 50 reads per operation. Every round's
deferred remainder stayed pending forever, so the pool at interruption is the
accumulator of all rounds' surpluses — 1,000–2,100 leads per operation in this run.

## Fix direction (implemented separately)

1. **Backlog retirement**: a lead deferred by selection while trailing the round's
   batch floor by more than a fixed margin is resolved `rejected` with its score and
   the floor in its reason — a decided record, not perpetual pending work. Near-miss
   leads stay pending and are reached when the head above them drains, so depth of
   discovery never causes a lead to be dropped (the contract pinned by the
   composition tests on the former eight-result cutoff).
2. **Planner throttle**: expansion spends a planner model call only when the pending
   pool cannot fill the next read batch.

Reproduction: the census commands are jq aggregations over
`artifacts/person-benchmark/live-discovery-expanded-004573b4dbe063a6-*.operation.json`
(per-operation headline counters from the record root; disposition/origin/family and
score distributions from the `leads` arrays).
