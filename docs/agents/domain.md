# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase.

This is a **single-context** repo: one domain, one crate tree, domain docs at
the root. The cargo workspace (`crates/app`) is a build unit, not a separate
domain, and crates do not carry their own domain docs.

## Where the vocabulary lives right now

The TypeScript-era domain docs — `CONTEXT.md` (glossary) and `docs/adr/` — were
deleted in the Rust cutover (issue #8). Until the Rust design settles, the
domain vocabulary and the record of settled decisions live in the issue
tracker: long-form spec issues, plus the wayfinder map `#1` and its children.
Read the issues that touch the area you're about to work in.

If none exist for your area, **proceed silently**. Don't flag their absence;
don't suggest creating them upfront. The `/domain-modeling` skill creates
`CONTEXT.md` and `docs/adr/` lazily when terms or decisions actually get
resolved — when that happens, ADR numbering restarts at `0001`.

## File structure

```
/
├── AGENTS.md
├── Cargo.toml
├── crates/
│   └── app/
└── docs/agents/
```

## Reuse vocabulary deliberately

When your output names a domain concept (in an issue title, a refactor
proposal, a hypothesis, a test name), use the term the issue specs use. Don't
drift to synonyms the specs explicitly avoid — words on an _Avoid_ list are
there for a reason.

If the concept you need has no name yet, that's a signal: either you're
inventing language the project doesn't use (reconsider) or there's a real gap
(note it for `/domain-modeling`).

## Flag conflicts with settled decisions

If your output contradicts a decision an issue has settled, surface it
explicitly rather than silently overriding:

> _Contradicts #12 (walking skeleton first), but worth reopening because…_
