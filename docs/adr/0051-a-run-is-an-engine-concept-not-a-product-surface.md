# A Run is an engine concept, not a product surface

The Shell's Run leaked into the product it was meant to serve. A cross-Module list at `/runs` and a
Run detail page behind it were the route by which a person reached their own data, so finding a
Meeting Debrief meant recognising it among every Module's work and matching it to a meeting by
hand. The word also flattened the product: it told a reader that preparing a meeting brief, mining
a transcript and counting a channel's views were the same kind of thing, which is true of the
engine and false of the workflows.

We will therefore stop presenting Runs. No product surface names a Run or links to one. Each
Module's output is reached from the surface that owns it — a Meeting Brief and a Meeting Debrief
from their Meeting's page, a Daily Briefing from the Meeting Wizard's front page, a Content Project
from its own page — and each of those surfaces reports its own failures, with its own retry.

Underneath, nothing changes. A Run is still one scope of work owned by one Module, with a status
and an append-only event log, and it is still what the Shell schedules, retries, waits on and logs.

## Considered Options

- **Rename the word.** Rejected because it addresses half the complaint. "Activity" or "History"
  removes the jargon and keeps the page, so a person still reaches their debrief by scanning a
  cross-Module list. The extra hop was the objection, not only the vocabulary.
- **Remove the concept.** Rejected as disproportionate. The Run carries the durable wait that
  ADR-0038 spends on human approval, the retry, the cost record and the append-only log. Removing
  it would rewrite the Shell and forfeit ADR-0020's machinery to fix a naming problem.
- **Delete the Run pages app-wide now.** Rejected because it takes a working Module dark. YouTube
  Trends deliberately ships no result view of its own: the Shell's Run detail page and the links to
  a Run's files are its result surface, recorded as a real answer for a first phase rather than a
  gap. Deleting that page would leave it with nowhere to show its output.

## Consequences

Every Module output now needs a home on a product surface, including its failures. The catch-all
that let an output exist with nowhere to live is gone, so a Module that gains a result must also
gain somewhere to show it. Home's activity feed links each entry to its owning surface, and its
overflow link to the Run list is removed.

The Run list and detail pages survive as technical surfaces. They are reachable from Settings and
from a failure's technical details, and from nowhere a person navigates on purpose.

YouTube Trends is the named debt. Full removal of the Run pages is blocked until it has a result
view of its own, and this is why a technical page still exists in an app that no longer presents
Runs.
