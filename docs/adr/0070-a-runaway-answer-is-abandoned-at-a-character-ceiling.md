# A runaway answer is abandoned at a character ceiling

The seam's three time ceilings all bound a call that produces too little: one asks whether the
connection is alive, one whether an answer is being produced, one how long the whole call may run.
Nothing bounded a call that produces too much. A runaway put 6.7 MB on the wire in the measured
case, and a model whose reasoning ran away produced 161,416 characters of it — each spending an
operation's whole budget on an answer that was never going to arrive. One streamed call may now
deliver at most 250,000 characters of answer; past that it fails as `answer_overrun`, its route
rests (ADR-0068), and what is left of the budget goes to the next binding, the same recovery
sustained repetition already earns (ADR-0064).

The ceiling is a volume, not a time, and that is deliberate. A shorter per-attempt time ceiling
would bound the same cost, but the measured answers to this contract take 84 to 227 seconds on the
routes that serve them, so a time ceiling low enough to bound a runaway would abort work that was
going to finish — the mistake the 30-second idle ceiling made in #232, repeated with a different
number.

It counts answer characters and not bytes off the wire, and that distinction was learned the
expensive way. The first version of this ceiling counted wire bytes at two megabytes, which looked
like sixty times the largest answer ever measured here. It is not: a route that streams one token
per event spends around 200 bytes of envelope per token, so two megabytes of wire is roughly ten
thousand tokens — inside what a real answer to this contract costs. Six live runs then recorded
legitimate generations reaching 1.49 MB and 1.58 MB when their own time ran out, and three
different routes stopped at exactly the ceiling. A byte ceiling measures how a route frames its
answer; only a character ceiling measures the answer. Reasoning counts towards it by length alone —
a count is shape, the words are not, and they are never retained.

The repetition detector stays: it catches a degenerate answer within a few hundred characters, long
before this ceiling, and names what went wrong more precisely. This one catches the runaway that
never repeats.
