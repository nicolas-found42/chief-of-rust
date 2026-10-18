# chief-of-rust

A single-user research workspace: it collects evidence about people and
companies, runs model-backed generation over it, and keeps every result as a
durable record the operator can audit.

## Language

**Workspace**:
The operator's own directory: one SQLite database, the Terminal archive, and
the Google token cache. Every installation runs over exactly one.
_Avoid_: tenant, account, project

**Installation**:
One running server: its configuration, its Workspace, its provider table, and
the model and judgment connections it was built from.
_Avoid_: deployment, instance, app

**Provider**:
One selectable model source, with the name the operator selects it by, the
credential that pays for it, the endpoint that serves it, and the model and
reasoning effort it runs.

**Provider table**:
The single list of Providers an Installation can select. A model name that is
not in the table is not a Provider.
_Avoid_: provider registry, catalog

**Connection**:
A live dependency an Installation hands to a route or a Run — a model
connection or a judgment connection. Connections are decided at construction;
callers never assemble one.
_Avoid_: client, handle, service

**Model connection**:
The model source a Run generates through, pinned to that Run.

**Judgment connection**:
The judging source a Run evaluates propositions through, carrying the Run's
own evaluation cache. _Avoid_: judge client, typesafe client

**Run scope**:
The per-Run view of an Installation: the Run's pinned model connection, its
request budget, and its judgment cache. Only a Run scope may judge.

**Run**:
One execution of a Job. A Run owns the session its parallel generation calls
share and the cache its repeated judgments share; a retry is a new Run.
_Avoid_: task, execution, invocation

**Attempt**:
The durable record of one try at a Job, kept beside the recovery that followed
it rather than rewritten by it.
_Avoid_: try, log entry

**Evaluation**:
The answer set one judging source returns for a state and a question set,
together with its usage. An Evaluation is only a Result once it satisfies the
contract its questions state.

**Judge**:
The judging source behind a judgment connection. Offline tests substitute a
fixture; the server uses the configured judging provider.
