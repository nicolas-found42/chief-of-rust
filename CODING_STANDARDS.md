# Coding standards

Read during **review**, not implementation. The reviewer has the diff and no exploration to do, so
the standards live here rather than in `CLAUDE.md`, where every implementation agent would carry
them on every turn.

Skip anything tooling already decides. Prettier settles formatting, ESLint settles lint, `tsc`
settles types, and `tests/vitest.config.ts` settles the coverage floors — a review that restates
one of those spends its attention twice.

Domain vocabulary is not here either: `docs/agents/domain.md` routes to the `CONTEXT.md` glossary
and its `_Avoid_` lists, and to the ADRs a change may contradict.

## Every declared value is reachable

A field typed as an enum has to be able to hold each value it declares. Code that can only ever
produce a subset is a defect in the field, the code, or both, and the narrower the write path the
easier it hides.

`updateCoverage` carried this for months (#238):

```ts
area.state = claims.length ? "satisfied" : area.state === "planned" ? "planned" : "investigated";
```

`state` starts at `"planned"` and nothing else writes it, so the middle arm is the only one a
planned area ever takes: two of the five declared states were unreachable, and every completed
research operation published a record saying its coverage had never been investigated. `tsc` sees
a well-typed conditional. ESLint sees no unused branch. The coverage floors are *satisfied* by
it — the arm executes on every run; nothing asserted on what it wrote.

So for each enum-typed field a diff writes, name where each value comes from. A value with no
writer is the finding.

## A finished record is not rewritten

Where a record says what happened, later knowledge is added beside it rather than over it. An
attempt keeps its own outcome and links to the recovery that followed (`attemptOf`); a stated cause
says whether it is `observed` or a `hypothesis` and is never upgraded by a summary; a resolved lead
keeps the disposition and reason it reached.

The pull is always toward tidying: a later pass knows more, and the old record looks wrong. It is
not wrong — it is what was known then, and the audit trail is the product. In review, a mutation
of an already-resolved record is a finding unless the diff says why that record was not final.

## Comments carry the why

Block comments explain the reason a thing is the way it is, and name the issue where the reasoning
lives:

```ts
/* Investigated, unreachable and rejected all mean "do not fetch this
   again": an owner's detachment and a wrong-person page are as final as a
   successful read, and re-crawling either wastes the next operation. */
```

A doc comment on an exported seam says what the export is *for* and what goes wrong without it,
which is why the ones in `apps/server/src/person-profile/` run several sentences. A comment that
restates the code beneath it is a finding; so is a non-obvious decision with no comment at all.

## A test asserts the record, not only its summary

Where a change writes a durable record, a test reads that record's contents. Asserting the derived
summary field alone lets the record beneath it go wrong silently: the whole suite asserted
`conclusion === "completed"` and not one test read the `coverage` array that the conclusion was
supposed to rest on, which is how the unreachable state above survived 2,186 passing tests.

## Prose is hand-wrapped

`*.md` is prettier-ignored (ADR-0026) because a reflow buries every real change. Match the
surrounding file's width, and keep a docs diff to the lines whose meaning changed.
