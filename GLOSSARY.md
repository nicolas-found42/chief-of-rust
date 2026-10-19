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
_Avoid_: deployment, instance

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
The judging source a Run evaluates propositions through, carrying the Run's own
evaluation cache. _Avoid_: judge client, typesafe client

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

**Subject**:
What an explicit Terminal research Run is about: one person or one company.
The workflow is shared; a Subject kind supplies the parts that differ.
_Avoid_: target, entity, object

**Subject kind**:
Which of the two a Subject is — `person` or `company`. Rules that differ by
kind belong to the kind's adapter or its specification; rules that do not
belong to the shared workflow.

**Subject specification**:
The per-kind facts a call site holding only a kind string needs: record kinds,
field names, job kinds, headings, excluded collectors and provenance ids.

**Brief**:
The generated prose for one Subject, published with its ledger and the model
that produced it. New briefs are written under one record kind carrying the
Subject kind; older person and company briefs stay readable and are never
rewritten.
_Avoid_: report, write-up

**Collector**:
One provider-specific retrieval — a single endpoint whose result can become
evidence. A Collector declares the family it belongs to, the arguments it
needs, whether it requires an operator contact, and whether it is
organization-scoped.

**Envelope**:
What one Collector invocation returned: the transport facts (status, final URL,
truncation, results count, notes) plus the provider's own payload. An Envelope
is not evidence; a Source is made from it.

**Source**:
One retrieved or attempted item of evidence, with the excerpts taken from it,
how it was reached, and how much of it was inspected.
_Avoid_: document, result, hit

**Excerpt**:
A literal span copied out of a Source. The application copies excerpts; a model
may choose among them but never writes them.

**Claim**:
An assertion about a Subject, with its status, the Sources that support it and
any that contradict it. A Claim is never published with a citation that does not
resolve to a literal Excerpt.

**Coverage**:
What was searched for one family and question: its state, the boundary that
bounded it, what was retrieved, and what remains. Coverage is how an absence
stays visible instead of silently becoming a negative finding.

**Frontier**:
The work a Run did not execute, recorded as a next action and the reason it was
left.

**Ledger**:
The Sources, Claims, Coverage and Frontier of one research subject, plus the
structural check that its references resolve. A Ledger says what was gathered
and what remains; it never asserts that a Claim is true.

**Debrief**:
The meeting counterpart of a Brief: candidate findings extracted from spoken
dialogue, each kept with its citation and its support verdict.

**Artifact**:
A generated, reviewable output of a meeting or content Run, carrying the model
that produced it and the revisions it was built from.

**Dossier**:
The published profile of a person, company or watched subject: its identity, its
narrative body, and the evidence behind it. Earlier Dossiers remain readable.

**Pacer**:
The per-origin rate-limit gate every Collector call passes through. Pacing
values belong to the Collector; the wait belongs to the Pacer, whose clock is
injectable so a test asserts the decision without spending the delay.
