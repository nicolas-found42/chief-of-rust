# The Google connection is not proven before a Run; it is classified when it fails

ADR-0007 models the Google connection as four states and proves a stored token by spending it. The
obvious next step is to prove it again before every Run, so that an expired token can never be
handed a Google surface. We are not doing that.

Proving costs two round-trips before work that may not need them, and it does not actually
establish what it appears to: a token proven at T can be revoked before it is spent at T+2s, so the
Run still has to handle a rejected grant at the point of use. The check would be a second, weaker
copy of an answer the next API call gives for free and gives authoritatively. Nothing is wasted by
finding out late either — extraction is cached before the outputs Stage, so a Run that dies on
Google is retried from outputs, not from the model.

So `outputs()` answers from what is already known and never touches the network, and `observe(error)`
turns whatever a real Google call threw into the state that explains it. Both paths converge on one
`GoogleConnectionState`, and one table turns that state into the failure hint the Run shows. The
previous arrangement had two vocabularies — a boolean for whether a Run could proceed, four states
for what the UI displayed — and the Run got the weaker one, which is why an expired token failed a
Run with "Retry, or check the events below" and retry could never fix it.

The state Google settles is remembered rather than recomputed, because `state()` costs two
round-trips and the answer only changes on events the connection itself sees: a settings save, a
sign-in, a sign-out, or a grant rejected during a Run. Only `connected` and `expired` are
remembered; `unconfigured` and `disconnected` are read from stored configuration every time, so a
credential changed outside this module cannot be masked by a stale answer.

Nothing proves the token on a schedule. A person may. The Settings card's **Check my setup** button
calls `verifySetup()`, which makes one deliberate read-only call per Google surface and turns each
403 into the console step that fixes it — a disabled API and a missing scope read differently in
Google's own error, so the answer can name the missing piece exactly. That is the boundary this ADR
draws: *automatic* proving is what buys a guarantee that expires immediately, whereas a person
asking "is my setup right?" is a different question, asked once, at the only moment two round-trips
are worth paying for. `state()` has always worked this way on the Settings page; `verifySetup()`
makes the rule explicit rather than incidental. A timer that refreshed either would need its own ADR.

The check earns its place because the alternative decays. The setup steps describe Google's console,
and Google renames it — the card described the pre-2025 console for months and nothing in this repo
could report it. Instructions written about Google go stale; answers obtained from Google cannot.

## Considered Options

- **Prove before every Run.** Elegant as a type — outputs reachable only from `connected` — but two
  round-trips per Run for a guarantee that expires immediately, and the rejected-grant path has to
  exist regardless.
- **Keep the boolean and translate the error at the call site.** Fixes the wrong hint without
  building the module, and leaves the second representation of the connection alive to grow a
  fourth caller, as it already had.
- **Recompute the state on every request.** Honest and simple, but Settings and Runs both ask on
  load, and a save re-asks: four Google round-trips for one page visit.

## Consequences

A Run is the thing that discovers an expired grant, so the first Run after a weekly expiry always
fails. That is the cost of not paying for a check before every Run, and it is bounded: the
connection remembers the rejection, so later Runs refuse before calling Google and the Settings page
reports `expired` without asking Google again. A rejected grant now aborts the outputs batch rather
than being counted as a per-item error — every remaining call would fail identically, and a partial
batch attributed to bad tasks was misleading.

The remembered state lives in one process and is lost on restart, which is correct: a restart is
free to ask Google again. Invalidation is wired through the existing `onConfigChanged` path in
`main.ts`; when the Settings module grows real change notification, the connection should subscribe
instead.
