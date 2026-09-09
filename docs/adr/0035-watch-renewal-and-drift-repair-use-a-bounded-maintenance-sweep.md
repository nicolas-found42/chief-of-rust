# Watch renewal and drift repair use a bounded maintenance sweep

ADR-0031 chose Calendar push over a scheduled look-ahead, and the Meeting Brief Generator spec
lists a periodic Calendar look-ahead as out of scope. Push remains the only way a meeting is
discovered. Two contracts nevertheless cannot execute themselves: the watch channel must be
replaced before the expiration Google returns, and a wake-up can be lost in ways no sync token
exposes — relay retention elapsing during a long offline period, relay cursor loss with an
intact sync token, or a silently dropped notification. Waiting for the next startup or
invalid-sync recovery to notice can silently forfeit the four-hour preparation promise for a
real meeting.

The Module's Host therefore runs one bounded in-process maintenance sweep on a slow tick
(thirty seconds): renew or replace the watch, process due Intake schedules, and force a full
incremental reconciliation at most every six hours. The sweep never creates work for future
meetings — meetings still wait in Intake per ADR-0032 — never polls per event, and an overlap
guard keeps at most one sweep in flight. The six-hour reconciliation is drift repair
subordinate to push, not a rediscovery loop; the spec's out-of-scope rule forbids replacing
push discovery with polling, not self-healing a delivery path that is only at-least-once.

## Consequences

The Host keeps its last-full-sync marker and in-flight guard in memory only; a restart simply
re-sweeps, and startup recovery already forces one full reconciliation. The tick interval and
the six-hour cadence are fixed in version 1 and unconfigured, like the four-hour lead time.
Relay retention, the watch renewal margin, and this cadence must jointly cover realistic
offline periods; if a missed brief is ever traced to drift, the cadence — not the push
path — is the knob to revisit.
