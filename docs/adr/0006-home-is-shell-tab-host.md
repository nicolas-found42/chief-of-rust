# Home is the Shell's tab host; Transcript owns `/`

**Superseded by [ADR-0010](0010-home-is-shell-status-surface.md).** Home is now a Shell status
surface at `/` and Transcript owns `/transcript`. The reasoning below is left as written, because
ADR-0010 answers it point by point.

Home is the Shell's tab bar, not a dashboard. The Transcript Module owns `/` and `/runs/:id`; the planned Hot Take Module owns `/hot-take`. We kept `/` for Transcript so existing bookmarks and the `Runs` NavLink keep working, and we mount the Hot Take placeholder as a real Module route so the registry seam (ADR-0002) is exercised from day one instead of adding a special-case Shell page.

## Considered Options

- Home as a dashboard linking to `/transcript` and `/hot-take` (extra hop, contradicts “Modules are tabs”).
- `/hot-take` hidden until implemented (hides roadmap, no seam exercise).
- `aria-disabled` Hot Take tab (not keyboard-navigable, worse a11y than a real page).

## Consequences

`Settings` stays in the Shell header, not in the tab bar. Tab active state reuses `NavLink` styling. Package scope was renamed to `@chief-of-staff-demo/*` in this slice; the GitHub slug rename to `chief-of-staff-demo` is a separate Settings click that 301s the old slug.
