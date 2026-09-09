# Calendar push uses an opaque cloud relay

The Meeting Brief Generator uses Google Calendar push channels rather than a scheduled look-ahead.
Because Google requires a public HTTPS callback and the Shell remains local-first, notifications
terminate at a minimal cloud relay that validates and buffers only an opaque calendar-changed
wake-up for the correct Shell instance. The relay holds no Google credentials or event contents;
the local Shell connects outward, receives the wake-up, and uses its Google connection to fetch the
actual Calendar changes. A direct tunnel into the unauthenticated local Shell and public hosting of
the whole Shell were rejected to preserve its existing trust boundary.

## Consequences

The system gains a second deployable component and must operate Calendar channel registration,
expiration and replacement. Delivery must tolerate duplicate or missed notifications: the wake-up
is never treated as event data, and the Module reconciles against Calendar's current state before it
starts Runs.
