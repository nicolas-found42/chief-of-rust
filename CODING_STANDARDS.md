# Coding standards

Read during **review**, not implementation. The reviewer has the diff and no
exploration to do, so the standards live here rather than in `AGENTS.md`, where
every implementation agent would carry them on every turn.

Skip anything tooling already decides. rustfmt settles formatting, clippy
settles lint, `cargo check` settles types, and the borrow checker settles most
of what a lint used to have to catch — a review that restates one of those
spends its attention twice.

Domain vocabulary is not here either: `docs/agents/domain.md` routes to the
issue specs a change must stay consistent with.

These rules are stack-agnostic and survived the TypeScript → Rust cutover
(issue #8); the incidents that earned them are recorded in the old repo.
Rewrite them with Rust-specific evidence as the rewrite earns its own.

## Every declared value is reachable

A field typed as an enum has to be able to hold each value it declares. Code
that can only ever produce a subset is a defect in the field, the code, or
both, and the narrower the write path the easier it hides. The compiler proves
this for enums the code constructs directly, so the finding hides where a
string is parsed into a variant, or where one narrow setter leaves the other
variants unwritable. For each enum-typed field a diff writes, name where each
value comes from. A value with no writer is the finding.

## A finished record is not rewritten

Where a record says what happened, later knowledge is added beside it rather
than over it. An attempt keeps its own outcome and links to the recovery that
followed; a stated cause says whether it is observed or a hypothesis and is
never upgraded by a summary; a resolved lead keeps the disposition and reason
it reached.

The pull is always toward tidying: a later pass knows more, and the old record
looks wrong. It is not wrong — it is what was known then, and the audit trail
is the product. In review, a mutation of an already-resolved record is a
finding unless the diff says why that record was not final.

## Comments carry the why

Block comments explain the reason a thing is the way it is, and name the issue
where the reasoning lives. A doc comment on an exported seam (`///` on a `pub`
item) says what the export is *for* and what goes wrong without it. A comment
that restates the code beneath it is a finding; so is a non-obvious decision
with no comment at all.

## A test asserts the record, not only its summary

Where a change writes a durable record, a test reads that record's contents.
Asserting the derived summary alone lets the record beneath it go wrong
silently: a suite that only ever asserted a status field while never reading
the data the status rested on is how an unreachable state survived thousands of
passing tests.

## Prose is hand-wrapped

Markdown is hand-wrapped — no formatter touches it — because a reflow buries
every real change. Match the surrounding file's width, and keep a docs diff to
the lines whose meaning changed.
