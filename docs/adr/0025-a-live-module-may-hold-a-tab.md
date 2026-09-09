# ADR-0017's worked example is withdrawn; its two axes stand

**Amends:** ADR-0017 (A live Module may be headless: lifecycle and presence are separate axes)

ADR-0017 separated two ideas ADR-0014 had fused — **lifecycle** (is the Module built?) and
**presence** (has a person anything to look at?) — and it was right to. It reached that separation
through one worked example: the Weekly YouTube View Count Module, which "reads a spreadsheet, asks
YouTube for view counts, and writes them back into the same spreadsheet; its entire output is a
column in a document the owner already opens." That example is now false, and it is withdrawn.

What was designed instead has a tab, sub-navigation, a new UI primitive, channel management, a
daily Intake, a cached index and a new Output Adapter. Nothing about the Module got bigger by
accident: the reason the original was headless was that it wrote into a spreadsheet somebody
maintained by hand, and the whole point of rebuilding it was to stop maintaining that list by hand
and to keep a history rather than a single replaced number. Once the app holds the history, the app
is where the history is read.

**The two axes stand exactly as ADR-0017 wrote them.** Lifecycle and presence are still different
questions, `headless` is still the word, and a headless Module is still finished rather than
unfinished. What is withdrawn is only the claim that this repo has an instance of one. It does not:
every committed Module either holds a tab or is planned.

**`CONTEXT.md` keeps the term and says so.** A term that defines a category with no member is worth
keeping when the category is real and the next Module may land in it — and worth annotating, so
nobody reads the glossary as a description of what exists today.

**The gap ADR-0017 opened is closed.** It ended by noting that a headless Module's Runs had nowhere
to live once they scrolled past Home's capped feed, and left where they are read as an open
question. The answer is the Shell's Runs list at `/runs`, which covers every Module and which each
Module's own page is a filtered view of. That was built for a different reason — an unfiltered
transcript page starts lying the moment a second Module makes a Run — and it happens to answer this
too.

## Consequences

No committed Module is headless, so nothing exercises that path. The first Module that genuinely
has nothing to draw will be the first to test it, and it now has somewhere for its Runs to be read.
