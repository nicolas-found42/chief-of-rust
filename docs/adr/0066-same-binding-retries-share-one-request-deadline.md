# Same-binding retries share one request deadline

Issue #228 observed an OpenRouter stream that produced partial tool arguments, then only transport
keepalive comments until its idle timeout. Its cause remains unknown. A request may opt into one
additional attempt on the same binding to recover from a transient idle or transport failure,
while retaining the original failure even when the next attempt succeeds.

The opt-in requires a sanitized attempt observer. It applies to the shared OpenAI-compatible
completion loop used by OpenRouter and Ollama; the other providers keep their fixed request policy.
Each actual completion request receives a wire-attempt ordinal, binding, outcome, diagnostic when
available, retry delay, and reason recovery stopped. The absolute deadline reports its terminal
event before returning, so a racing timeout cannot erase the last attempt. These are wire attempts,
not additional logical model calls. Existing binding recovery attempts are also visible when the
observer is enabled.

A classified transport failure, a streaming idle or silent timeout, or an upstream capacity refusal
qualifies. Before retrying, the failed stream is aborted and at least 30,500 ms must remain in the
original request deadline. Backoff is fixed at 500 ms; the deadline and an optional caller lifecycle
gate are checked again afterward. Retry reuses the same model, binding, routing parameters, prompts,
sampling parameters, and full Result Shape. Partial answers from separate attempts never combine.

There is one additional same-binding attempt per logical call, not one per binding rung. Ordinary
declared-binding refusals, malformed answers, and the absolute request timeout do not retry.
ADR-0064's repetition recovery and the existing unknown-support refusal ladder remain separate,
share the same absolute deadline, and cannot reset the retry allowance. Without the opt-in, the
existing failure policy remains unchanged. Cancellation of the caller's retry gate prevents another
request; it does not claim to cancel a provider request already in flight.

## Amended 2026-09-08: capacity refusals qualify

The original scope was a classified transport failure or the thirty-second streaming idle timeout,
written when issue #228's stalling stream was the only failure in view. It excluded an upstream that
refuses for want of capacity — a 429, or a 502/503/504 the upstream names as its own — and that
exclusion cost the Person Research Benchmark every measurement it had. The judge's support phase
makes exactly one model call per Benchmark Person and has no stage-level tolerance, so a single
refusal ended the phase: 24 of the 27 phases that ran failed, every Benchmark Assessment was
incomplete, and every comparison read `not-comparable`.

The refusal is transient, and that is measured rather than assumed. One identical request sent three
times on the pinned route gave a 502 at 121.7s, an answer at 29.7s, and a 502 at 121.2s. The route
that refused had not stopped serving, which is what ADR-0068 already says in its own reasoning for
resting nothing on such a fault: the upstream "answered, said what went wrong, and may well answer
the next one". ADR-0068's further claim — that such a fault "would be answered the same way on every
route" — does not survive the measurement, and is corrected here for the retry question only.
Route resting is unchanged, and the two stay disjoint for this class: `restFailedRoute` earns a rest
from a repetition loop, an answer overrun, a timeout or a 429, never from an `upstream_error`, so a
capacity refusal rests nothing and the retry carries the routing parameters the first attempt used.
That matters on the pinned model, where resting the one route would leave the retry asking to route
around the whole pool.

Two boundaries hold the widening in place. The condition asked is
`isUpstreamCapacityRefusal`, not `isModelCapacityFailure`: the latter also answers true for any
`request_timeout`, including the absolute request ceiling that has already spent the deadline a
retry needs, and retrying that remains incoherent. And an upstream naming a non-capacity fault of
its own keeps the old policy, because it would answer the same way next time.

One gap is recorded rather than closed. On the OpenRouter streaming path an HTTP 429 does not reach
this gate at all: the response is returned rather than thrown, and the refusal surfaces later from
the answer-shape read, which belongs to the binding ladder. A 429 therefore retries on the
non-streaming path and does not on the streaming one. Closing that needs the two sites to raise
capacity refusals alike, which is a restructuring this amendment does not attempt.

This extends ADR-0029 and ADR-0065 without interpreting a timeout as evidence that a weaker binding
is supported. Successful recovery still requires normal answer parsing, caller validation, and
research completion checks. It does not by itself establish live benchmark quality acceptance.
