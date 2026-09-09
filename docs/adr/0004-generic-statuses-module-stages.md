# Run status is generic; detail lives in Stages

**Amended by [ADR-0020](0020-shell-owns-the-durable-wait.md).** The `blocked` status this
ADR pre-authorised is now spent: a Run holds it while a durable wait stands against it. The
shared set is `pending`, `running`, `blocked`, `done`, `skipped`, `failed`.

A Run's status is one of `pending`, `running`, `done`, `skipped`, `failed` for every Module. The
original statuses (`extracting`, `creating-outputs`) were the transcript workflow's vocabulary, and
keeping them would force every later Module to claim it is "extracting" when it is not. Per-Module
status enums were the other option, and they collapse: the UI cannot know what an unknown status
means, so each Module would have to ship "is this terminal / did it succeed" metadata, which is
this shared set again, living underneath as a second concept.

Detail moves to Stages instead. A Module names its own Stages (see ADR-0003) and the Shell logs
each one, so the Run timeline is richer than the old status field was, and retry keys on the failed
Stage name rather than a fixed `extract | outputs` enum. Stage names are discovered as a Run
executes, not declared up front: a declared list duplicates what the code already says, cannot
express a conditional Stage, and drifts silently when someone adds one.

## Consequences

This breaks the shape of `meta.json`, the status pill, the retry route, and part of the test suite,
and existing Runs read as legacy (a missing Stage is treated as `extract`). We take that cost now
because it only grows once a second Module exists. The list view loses a little information —
`running` where it used to say `extracting` — so it shows the current Stage beside the status. If a
Module ever needs "stopped, waiting for a human", `blocked` is added to this shared set as a
considered change, not as per-Module freedom.
