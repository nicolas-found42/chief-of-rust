# A failed upstream route rests before it is asked again

OpenRouter serves one model from many upstream routes and chooses per call, and those routes do
not fail alike: on the configured model one answered a degenerate repetition loop of 6.7 MB, five
answered HTTP 429, and one buffered a whole answer past every ceiling, while others completed the
same request in 84 seconds. A route that fails in a way that costs the call now rests for fifteen
minutes, and the next call carries the resting routes as `provider.ignore` so OpenRouter routes
around them. The precedent is `createPublicSearch`, which rests a refusing search provider for the
same reason; the state is process-wide for the same reason the search cooldowns are app-wide —
one account meets every route's capacity, so a rest one Stage learns is a rest every Stage owes.

Only a failure that belongs to the route rests it: a stalled stream, a repetition loop, or a
capacity refusal. A refused binding, an unusable answer shape, or an upstream naming a fault of
its own rests nothing, because those would be answered the same way on every route and resting on
all of them alike would empty the routing pool. At most eight routes rest at once, newest first,
so a bad stretch cannot narrow a model served by few endpoints down to none.

## Considered options

A measured allowlist of good routes was rejected: issue #228 warns against pinning catalogue
labels that go stale, and route quality is a property of the moment rather than of the name.
Resting is the same information used in the safe direction — it names what has just been observed
to fail rather than claiming to know what will work.

`provider.ignore` was verified against the live API rather than assumed: it accepts the route name
exactly as the stream reports it in its `provider` field, including names with spaces and dots
(`Sail Research`, `Z.AI`), so no slug mapping or catalogue lookup sits between the observation and
the control. An unrecognised name is accepted and ignored rather than refused, so a rest can fail
only by having no effect.
