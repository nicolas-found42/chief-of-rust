# The Shell holds credentials and durability; a Module holds its workflow

ADR-0003 already decided this and titled itself "Modules own control flow; the Shell owns
everything durable". It was never built: there is no `run(ctx, input)` and no `ctx.stage`, and
`Pipeline` still owns the queue and calls the transcript workflow's Stages itself. ADR-0009
recorded the deferral out loud — "the wrapper stays in the Pipeline until that work is done". So
this ADR **re-affirms** ADR-0003 rather than amending it, and states the two things ADR-0003 left
open: where a provider's credentials stop, and what a Module declares.

**The Shell holds a provider's credentials and nothing more.** Many Modules will share one
provider and none will share what they do with it — one lists a Drive folder, one exports a Doc,
one reads a Sheet, one searches Gmail for a reply. A Shell that owns any of those actions has
taken on one Module's knowledge (which file names matter, which column holds a view count) and
will have to grow again for Module nineteen. Credentials are the only part that is the same for
every Module. So an **Intake** is Module work: the Shell watches nothing and delivers nothing, and
`intake/drive.ts` belongs to the transcript Module.

**Time is not a provider.** A schedule is not a call to an API, and a wait that must outlive a
container restart can only live in the Shell. The Shell therefore owns a durable clock (ADR-0020)
without owning any watcher.

The Shell holds: credentials per provider; the Workspace and every durable write; a Run's
identity, status, transitions and event log (ADR-0009); the durable clock and wait; Home,
navigation and the Runs list; the Module registry. A Module holds: its Intake; its own control
flow and Stage names; its result shape, stored opaquely with one summary line supplied for the
Runs list; its Output Adapters; its retry policy and what a partial failure means.

A Module declares to the Shell its identity, its Intakes, whether it has anything to show
(ADR-0017's presence axis), the summary line it supplies for a Run, and its version. This ADR
settles that contract and not its code: ADR-0002's registry is also still unbuilt, and
`useModules.ts` remains the seam it says it is.

## Considered Options

- **Teach the Shell the workflow structures** — sequence, parallel, condition, fan-out, join,
  timer, human wait, sub-workflow, partial failure, cancellation. This is what the counts in the
  work ticket appeared to demand, and it is what an outside proposal recommended. Rejected on a
  recount: the "Thread" the Relay export counts is a nested sub-sequence, not a concurrent one.
  Across all 163 Relay Workflows a Thread starts only at a `paths` step (176), an `iterator` step
  (86), or a prompt called as a tool (5). For the seventeen in scope the arithmetic is exact —
  twelve have a loop, two more have a condition, twelve plus two is fourteen — and a `paths` step
  selects one branch, which the Relay executions record as "Path selected by rules". Of 356 loops
  that ran two or more items in the exported executions, 318 ran one item after the other; the 38
  that overlapped belong to three Relay Workflows. So the structures a Module hand-rolls are a
  loop and an `if`, which is TypeScript, and teaching the Shell a second language for describing
  them buys nothing.
- **Let the Shell own the watchers and deliver arrivals** to whichever Module cares, with a new
  term for the arrival. Rejected: it puts one Module's filter in the Shell, and it adds a Shell
  concept where the credential rule above already draws the line. It also proved unnecessary —
  removing it removed a word rather than adding one.
- **Let the Shell only append events** and give a Module the Workspace directly. Rejected:
  ADR-0003 already routes every durable write through the Shell, and a Module that writes state
  itself makes a Run's status and its timeline able to disagree again, which is exactly what
  ADR-0009 removed.

## Consequences

The first Modules after this cost more, not less, because each writes its own Intake and its own
loops. That is affordable only because of the recount: what is repeated is ordinary TypeScript,
not an execution model.

One cost is real. Six of the seventeen in-scope Relay Workflows start when a transcript lands in
Drive, so six Modules will eventually poll one folder — six timers, six sets of quota, six
memories of what each has seen. Six timers on a two-minute interval for one user is not worth an
abstraction, but the memory is: commit c69293e fixed a double-ingest that produced two Runs, two
sets of Google Tasks and two Gmail drafts from one file, and each Module can repeat it. The Shell
therefore offers "have I seen this identifier before?" as a plain helper over the Workspace. It is
memory rather than a poll, it is durable so ADR-0003 puts it behind the Shell in any case, and it
is a helper and not a new concept. If a third Drive-watching Module makes the quota bite, revisit
the watcher — not any of the concurrency arguments this ADR rejects.

The Shell cannot make two Modules do the same thing the same way; ADR-0003 already accepted that
consistency is review discipline. One Module may not start another's Run yet. One in-scope Relay
Workflow calls another (`relay.runPlaybook`, four across the 163), which is too few to design a
contract for, and ADR-0002 keeps them in one process so nothing is blocked. When a second case
appears the answer is a declared dependency in the registry, not a direct call.
