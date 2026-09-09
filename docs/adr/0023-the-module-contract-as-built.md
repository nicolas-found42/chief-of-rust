# The Module contract, as built

**Realises:** ADR-0003 (Modules own control flow; the Shell owns everything durable)

ADR-0003 said a Module exports `run(ctx, input)`, names its own Stages through one wrapper, and
reaches everything durable only through the context. The code never did any of that. One class
supplied both the generic Run engine and the transcript workflow's Stages, its stage names were
literals inside it, and the Shell's own list of Runs read inside a Module's result to count Google
Tasks. This ADR records what was built to make ADR-0003 true, because a decision that was
aspirational for a year is worth writing down the day it stops being.

**The engine and the Module are separate objects.** `apps/server/src/engine/runner.ts` creates
Runs, hands a Module its context, records every Stage, serialises work through one promise chain,
and carries out a retry the Module planned. It holds no Module's Stages, Intakes, event names or
result. One `Runner` per Module; adding a Module needs no change to it.

**`ctx.stage(name, fn)` is the whole of the uniformity.** The Shell writes the Stage events,
records the Stage on the Run for retry, times it and catches failures; the Module chooses the names
and the order.

**Every durable capability is refused outside a Stage.** Writing one of the Run's own files,
appending an event, counting an attempt — each throws when no Stage is open. That is what stops a
Run's status and its timeline disagreeing: whatever the Shell recorded, it recorded inside a named
span. A Module's own collaborators — a model, a Google surface, its configuration — are not on the
context: they belong to the Module, and what the Shell gates is the Shell's own machinery.

**A Module declares its identity, its version, its Stage hints, its retry plan and its Runs'
summary line — and no result schema.** The Shell stores a result opaquely and reads inside it
nowhere. The retry plan is declarative (`{ fromStage, input, resetAttempts?, discard? }`) rather
than performed, because a retry is decided outside any Stage and a Module may not write durably
there; the Runner carries it out.

**A Module is held by the Shell as a `HostedModule`**: identity, `retryRun`, its own endpoints, and
start/stop for its Intakes. The API holds a collection of them and nothing Module-shaped besides,
so `POST /api/runs/:id/retry` finds the Module from the Run rather than assuming which one it is.

**This is still not ADR-0002's registry.** Nothing declares itself and nothing is discovered:
`main.ts` constructs each Module and hands the list over. That is the seam a registry can slot
behind, and it stays unbuilt because nothing needs it.

## Consequences

The claim that this refactor changed no behaviour is evidenced rather than asserted: the transcript
Module's test file passed across the split with no edits at all. That was the point of keeping the
engine's entry points, and it is the strongest evidence available for a refactor of this shape.

Consistency between Modules stays a code-review discipline, exactly as ADR-0003 warned. What the
type system now enforces is narrower and more useful: a Module cannot record anything outside a
Stage, and the Shell cannot read inside a result.

The Shell's display vocabulary still holds a map of every Module's Stage names
(`apps/web/src/display.ts`), because a person needs to read "Read view counts" rather than `fetch`.
It falls back to the raw key, so a Module whose Stages are absent from it degrades to a diagnostic
rather than to a blank.
