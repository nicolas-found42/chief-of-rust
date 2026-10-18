# A research Subject is one workflow over two adapters, and its brief record is unified

Person research and company research were two files of about 850 lines each
that shared six function pairs and no implementation: the same collector loop,
the same evidence rules, the same version fence, the same brief publication
path, written twice and drifting. Every change had to be made twice and proved
twice, and a fix in one was invisible to the other.

We decided the **workflow is written once** and the two subjects are adapters
behind a `Subject` seam. What differs by kind is either behaviour of the
adapter (planning its collectors, supplying prior history and context, the
synthesis prompt) or a row in `SubjectSpec` (record kinds, field names, job
kinds, headings, excluded collectors, provenance ids). A call site that holds
only a kind string consults the specification rather than repeating
`if kind == "person"`.

We also decided the **brief record is unified and the unification is
non-destructive**: new briefs are written under one kind carrying the subject
kind, while existing `person_brief` and `company_brief` rows stay readable
through serde aliases and an explicit fallback that infers the kind from the
legacy id field. Nothing in an existing Workspace is rewritten. `CODING
STANDARDS.md` already states that a finished record is not rewritten;
rewriting every historical brief to save one read-time alias would put the
operator's only copy of that evidence through a migration for no behavioural
gain, and the alias is testable in a way the migration is not.

Considered and rejected: keeping the two kinds as separate modules and
extracting only the loop. That leaves the version fence, the brief shape and
the route pairs duplicated, which is where the drift actually happened, and it
keeps every kind decision at a call site instead of in one table.

Consequences to expect: the four explicit research job-kind strings, both route
paths and the synthesis prompt text are deliberately unchanged, so nothing
outside the module had to learn a new vocabulary; and a reader looking for a
per-kind rule should now look in `SubjectSpec` or an adapter, never in a
`match` on a kind string.
