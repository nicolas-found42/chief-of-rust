# Modules own control flow; the Shell owns everything durable

A Module exports `run(ctx, input)` and decides its own order of work, because the Modules are not
one shape: the transcript Module writes Google Tasks and Gmail drafts, the Executive Coach Module
writes a document, and the Briefing Module must read the calendar before it calls a model. A
declarative contract (prompt + schema + adapters, Shell runs a fixed pipeline) fits only the first
of those, and a fixed step list forces every kind of work through one signature.

Uniformity comes from a single wrapper instead: `ctx.stage(name, fn)`. The Module names its stages
and orders them; the Shell writes the stage events, records the stage on the Run for retry, times
it, and catches failures. Every durable capability — model calls, Output Adapters, Run directory,
Module state — is reachable only through `ctx`, so a Module cannot do durable work outside a
stage.

## Consequences

The Shell cannot force two Modules to do the same task the same way; consistency between Modules
is a code-review discipline, not a type constraint. In exchange, adding a Module needs no change
to the Shell, and a Module can be tested by driving `run()` with a fake `ctx`.
