# A lead outranked beyond the selection margin is decided, not pending

One Person Research Operation materializes every discovery result as a lead and
defines completion against that registry: every lead must reach a disposition. The
expanded pipeline's bundle returns up to sixty merged results per query, four queries
run per round, and the read batch works through eight — so the pending pool grows an
order of magnitude faster than any pinned allowance can drain it (#239's census:
31,251 leads across one 30-person run, 89% ending `interrupted`, wall-clock backstop
binding with model calls barely half spent). An operation whose queue can only end as
interruption debris cannot complete, and "unresolved" dominated every recorded lead
disposition.

Selection already re-scores the whole pool every round against relevance,
independence and unfilled coverage. The committed census shows its ranking separates
sharply: read batches start at score 8.4 (p10) where the deferred pool's 90th
percentile sits at 6.35. That measured verdict is the decision: a lead deferred this
round whose score trails the batch's own floor by more than the selection margin
(2 points) is resolved `rejected`, with the score and the floor in its reason. The
ranking's verdict replaces the interruption's default, and unresolved leads stop
dominating the record.

What the margin deliberately protects: a lead within the margin of the batch stays
pending and is read when the head above it drains. Depth of discovery never causes a
drop — the repo removed an eight-result reading cutoff once already, and the two
composition scenarios that pin deep evidence (a quoted record at merge rank 9, a
registry page at rank 60) score within the margin of their batches and survive. A
count-based rule ("deferred N rounds") was rejected because it retires those
near-misses too: crowding, not ranking, would decide them.

Expansion also spends its planner model call only when the pending pool cannot fill
the next read batch. While the pool holds a batch, the deterministic derivation runs
and the call would buy a longer queue rather than better aims; model calls are the
operation's scarcest allowance.

The lead policy is named in both benchmark pipelines' recorded conditions. It is
shared machinery, not an arm difference: the incumbent reconstruction and the
expanded candidate run the same policy, so a later comparison attributes what it
measures.
