# Five local UI primitives, no design system

**Amended by:** ADR-0022 — there are six. The sixth is a single-series line chart, and that ADR
also records why a Module's sub-navigation is not a seventh.

The app is plain React with browser-default styling. That was a fine default while there was one
Module, but it makes every kind of information weigh the same: default blue underlined links,
uniformly bordered boxes, native form controls, large empty regions. The fix adopted here is
neither a dependency nor more defaults — it is five named CSS classes that the whole UI composes
from:

1. **Page header** — title, one line of context, the page's primary action.
2. **Card** — a bordered grouping for one object or one configuration topic.
3. **Status badge** — the small pill that classifies a thing's state (`Completed`, `Needs attention`).
4. **Action button** — the boxed call to action, distinct from inline links.
5. **Disclosure / timeline row** — the expandable row; the unit of progressive disclosure.

No component library and no design-system package. The cost being avoided is real but not yet
payable: a single user, one live Module, and a styling surface small enough that five classes cover
it. The primitives are ordinary CSS over semantic HTML, so adopting a real system later means
mapping five names, not unwinding a framework.

The reason this is recorded at all is that both rejected alternatives look reasonable from the
outside. "It's plain React" invites adding Mantine or Tailwind the first time a page looks rough;
"no design system" invites reading the primitives as accidental and deleting them for defaults.
They are deliberate: the information architecture underneath the old styling was already sound —
what it lacked was visual weight that tells apart the things that matter from the things that
merely exist.

## Consequences

Every new surface composes these five before inventing new chrome; a sixth primitive is a
considered change like any other. Existing class names (`card`, `status-pill`, step links) map onto
the primitives rather than multiplying alongside them — one vocabulary, not two.
