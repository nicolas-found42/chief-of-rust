# The owner identity is read once and held until the connection changes

ADR-0034 fixed the Meeting Brief recipient to the workspace owner's connected Google identity but
left open when that identity is read. It is read from the Google connection and held, not re-read
per delivery: the eligibility owner is refreshed eagerly, before any Module starts, so the owner is
known before the first Run rather than discovered by one, and the delivery recipient is resolved
lazily on the first send. Both are discarded whenever the connection changes, and re-read on the
next use.

## Considered options

Reading the identity per delivery was the obvious alternative and was rejected. It puts a live API
call in front of every automatic external write, so a transient Google failure becomes a delivery
failure, and it buys nothing: the value changes only when someone connects a different Google
account, which is an event the Shell already observes and can act on directly. Holding the value
also keeps eligibility honest — the owner decides whether a meeting is an Eligible Meeting at all,
and an owner that is null merely because a read failed would silently change that verdict.

## Consequences

Invalidation is load-bearing rather than housekeeping. A held recipient that outlives its
connection would address a brief to the previous account, so connecting a different Google account
must discard both values; the Shell does this on every configuration change and then refreshes.

The two values come from different reads of the same account — the connection's own identity
record for eligibility, and the live Gmail profile for the send — so they are not guaranteed to
agree. The delivery path uses the Gmail profile deliberately, because it is the address Gmail will
actually send as.

An unconnected workspace has no owner. That is a typed state, not an error: delivery cannot send,
records the state, and the Run stays retryable, so connecting the account later lets the same Run
finish.
