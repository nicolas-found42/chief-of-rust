# The Runs module owns transitions; Modules own policy

A Run's status and its event log are two files that have to agree, because the Run detail page
renders them side by side and retry keys on what `meta.json` says. They used to be kept in agreement
by convention: the Pipeline created one `RunMeta` object, mutated it across four methods and several
awaits, wrote the whole copy back, and appended a matching event by hand each time. Every status
change was a read-modify-write in the caller, and nothing but review caught a write with no event,
an event with no write, or a stale copy overwriting a fresher one.

The Runs module now exposes what can happen to a Run instead of the files a Run is made of:
`started`, `failed`, `finished`, `attemptStarted`, `resetAttempts`, `reopen`, and a `read()` that
returns a snapshot. Each transition re-reads `meta.json`, applies its change, writes it, and appends
its events, so no caller holds durable state and the pair cannot drift. `writeMeta`/`readMeta` are
gone from the interface; the payload files — result, transcript, context — keep explicit accessors,
because they are payload and not state.

The split with Modules is the part worth recording. **Runs records what happened; the Module decides
what it means.** Runs does not know that `convert` cannot be retried, that a failed `extract` should
discard the cached result and count attempts again, or what wording a failure deserves — those are
the transcript workflow's rules, and a second Module will have different ones. Conversely a Module
cannot move a Run without the timeline saying so, because there is no longer a way to write status
directly.

## Considered Options

- **Keep the accessors and add a lint or review rule** pairing every `writeMeta` with an
  `appendEvent`. The invariant stays in people's heads, which is where it already failed.
- **Move `stage(name, fn)` into Runs as well.** That is the Run engine of ADR-0003, and building it
  here — without the Module seam that gives it a point — would be ADR-0002's registry under another
  name. The wrapper stays in the Pipeline until that work is done.
- **Let Runs own retry policy too**, so `reopen` decides what to reset. It would need to know that
  `convert` is unrepeatable and that `extract` owns the cached result, which is one Module's
  vocabulary in the Shell's module — exactly the coupling ADR-0004 removed from the status enum.

## Consequences

`meta.json` is written through a temp file and a rename, because a torn meta is the one failure that
makes a Run vanish from the list rather than merely look stale. A retry now appends `run_reopened`,
so a timeline read later distinguishes a resumed Run from a slow one; the event union grows by one
entry, which is the last time that should be necessary before it opens to a plain string under
ADR-0002's registry.

Transitions re-read `meta.json` on every call, so a Run in flight costs a few more small synchronous
reads. That is the right trade at this size — Runs are infrequent and single-user (ADR-0001) — and
it is what makes a held copy impossible to write back.

The run directory now has one owner in fact and not only in intent: `main.ts` constructs `Runs` once
and injects it into both the Pipeline and the API, which previously opened it independently.
