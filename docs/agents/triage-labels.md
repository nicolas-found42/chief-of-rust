# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual strings used in this repo's issue tracker.

On this tracker these are literal GitHub label strings, applied with
`gh issue edit <n> --add-label "<label>"`.

## Canonical triage roles

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

## Working vocabulary beyond triage

Carried over from the `chief-of-staff-demo` label set; the port keeps it.

| Label | Meaning |
| ----- | ------- |
| `bug` | Something isn't working |
| `enhancement` | New feature or request |
| `question` | Further information is requested |
| `documentation` | Improvements or additions to documentation |
| `accessibility` | Barrier affecting people with disabilities |
| `spec` | Binding spec document |
| `wayfinder:map` | Wayfinder map issue |
| `wayfinder:research` | Wayfinder research ticket |
| `wayfinder:prototype` | Wayfinder prototype ticket |
| `wayfinder:grilling` | Wayfinder grilling ticket |
| `wayfinder:task` | Wayfinder task ticket |

Effort labels (one per named effort — the old repo used e.g. `shell-module-boundary`,
`relay-to-modules`) are created per effort rather than enumerated here.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the
corresponding string from the canonical table above.
