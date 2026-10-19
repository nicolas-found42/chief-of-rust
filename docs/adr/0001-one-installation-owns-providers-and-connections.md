# One installation owns the provider table and the connections

An `App` used to be a public struct that every route, worker and test assembled
by hand: five fields, spelled out at each call site, with the model and judgment
connections derived inline from `Config`. Nothing owned the answer to "which
providers exist and how is this process wired to them", so provider names and
endpoints were mapped in six places, and a test that wanted a different model
connection mutated a live handle's field.

We decided an **installation** owns the provider table and the connections, and
that `App` is built only by constructing an installation. `App`'s fields are
private; callers read them through accessors (`cfg()`, `db()`, `llm()`,
`judge()`, `pacer()`) and change a connection only through a rebind
(`with_cfg`, `with_llm`, `with_judge`) that carries the rest of the handle
forward. The provider table lives in `installation::providers` — one row per
provider, giving its name, credential, endpoint override, model and effort — and
`Config`'s provider accessors, the live-provider wiring and the settings routes
that edit a saved selection all read that table instead of matching on names
themselves.

Considered and rejected: leaving the fields public and adding a constructor
beside them. The literals were the defect — a second way to build a handle means
a second place where the provider table and the connection wiring can disagree
with the installation the process actually started with, and no test can tell
which one it exercised.
