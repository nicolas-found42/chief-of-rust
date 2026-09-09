# The Shell owns a durable wait, with two ways to resume

Two of the seventeen in-scope Relay Workflows pause on a clock — Weekly AI Wins waits from Friday
to Monday — and three pause on a person, all three in the Daily Hot Take family. The app is a
Docker container that will be restarted, and only the Shell survives that, so a wait is Shell work
whichever way the boundary falls (ADR-0018).

**One concept, two ways to resume.** A Run is waiting. It resumes either because the Shell's clock
reaches a time, or because a Module tells the Shell to resume it. There is no third mechanism, and
in particular a clock wait and a person wait are not two subsystems: the Shell persists one wait
record either way. A person wait resumes the second way because finding the reply is a call to a
provider, and ADR-0018 puts every such call in the Module — the Module searches Gmail and says
"resume Run X".

**`blocked` joins the shared status set.** ADR-0004 pre-authorised this in as many words — "if a
Module ever needs 'stopped, waiting for a human', `blocked` is added to this shared set as a
considered change, not as per-Module freedom" — and `RUN_STATUSES` has never spent it. It is spent
here. `blocked` is not terminal, and it is the status a Run holds while a wait record stands
against it.

**An indefinite wait must be stated, not defaulted.** The Daily Hot Take Relay Workflow has 115
Relay executions and 84 of them end at "Wait started", parked because the pause was configured
never to time out. That is forgotten configuration, not design intent. A wait therefore carries
either a timeout or an explicit statement that it has none, and a standing indefinite wait is
visible on Home — which under ADR-0017 is already the only surface a headless Module has.

## Considered Options

- **Two mechanisms, one for a clock and one for a person.** Rejected: they differ only in what
  wakes the Run, and the wait record is the same record. Two subsystems would double what has to
  survive a restart.
- **Let a Module keep the wait itself** — a promise, a timer, an in-memory closure. Rejected: a
  three-day wait cannot be held in a process that gets restarted, and this is the one capability a
  Module provably cannot provide.
- **Forbid indefinite waits.** Rejected: some of these workflows legitimately wait on a person who
  may never reply. The fix for the 84 is that the choice is explicit and visible, not that it is
  unavailable.
- **Design the mechanism now.** Deliberately not done. Durable-execution engines have solved this,
  and reading how they model the wait record and its resume is worth doing before inventing one.
  That research has not been commissioned: no in-scope Module needs a wait until a Hot Take Module
  is built, and this ADR settles ownership so the research is scoped when it happens rather than
  fired blind.

## Consequences

Nothing is built by this ADR. It fixes where the capability lives so that ADR-0019's Run definition
can stop implying that a Run ends, and so that the Hot Take Module has an answer waiting when it is
specified.

The wait sits on top of a defect it does not fix. There is no restart recovery at all today: the
queue in `Pipeline` is an in-memory promise chain, `main.ts` starts nothing but the Drive poll at
boot, and a Run caught `running` by a restart stays `running` forever and cannot be retried,
because `retryRun` requires `failed`. A durable wait is meaningless until a Run can be picked up
again after a restart, so that defect is sequenced ahead of any of this — after the second Module
exists, when the shape of durable in-flight state is known from two Modules rather than one.
