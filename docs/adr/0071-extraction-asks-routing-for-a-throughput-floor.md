# Extraction asks routing for a throughput floor

OpenRouter serves one model from many upstream routes and already sorts them
by its own measured throughput, but sorting alone does not know which routes
just cost an operation: on the configured model the routes that lose an
extraction generate at 24–28 tokens/second against 66–75 on the routes that
complete it (#232). At 24–28 tokens/second a 5,000-token dossier answer needs
roughly 200 seconds, past the operation's budget before anything goes wrong —
so the first attempt should start on a fast route rather than discover one by
failing.

Extraction therefore sends `preferred_min_throughput: 50` beside
`sort: "throughput"` (and beside any resting routes from ADR-0068). It is a
preference, never a pin: routes below it are deprioritized, not excluded, so
a stale number degrades to today's sort order instead of failing, and a
number the router does not recognise can only do nothing. Opt-in per request,
so each caller names the number its own measurements justify.

An allowlist of fast routes was rejected for the same reason ADR-0068 rejects
one for bad routes: route quality is a property of the moment, not of the
name. A floor states what "fast enough" means and lets the router apply
today's measurements.

The floor is named in each extraction attempt's research-record configuration
and in the benchmark report's provenance, alongside provider and model on
every attempt event — a routing change must stay attributable in any later
comparison, never a silent speedup.
