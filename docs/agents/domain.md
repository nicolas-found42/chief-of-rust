# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo: one `CONTEXT.md` and one `docs/adr/`, both at the root.
The npm workspaces (`apps/server`, `apps/web`, `packages/shared`) are build units, not
separate domains, and they do not carry their own domain docs.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary of domain terms.
- **`docs/adr/`**: read the ADRs that touch the area you're about to work in. Numbered
  from `0001`; a later ADR may supersede an earlier one, so check for a supersession note
  before treating an old decision as live.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-local-first-single-user.md
│   ├── 0002-modules-as-registry-in-one-process.md
│   └── …
├── apps/
│   ├── server/
│   └── web/
└── packages/
    └── shared/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids — it carries an _Avoid_ list, and words on it are there for a reason.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (per-user Google OAuth client), but worth reopening because…_
