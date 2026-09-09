# Model-boundary failures are classified facts, not sentences

Every Module reaches a model through one Shell seam, and until now every failure at that seam left
it as a bare `Error` with a prose message. Downstream code then matched those strings to decide what
had happened — the Idea Engine read `/429|quota|rate.?limit/i` off the message to decide whether to
back off — so one sentence had to serve both a person reading a Run and the code deciding whether to
retry. It served neither. `unexpected chat-completion response shape` did not say that `content` was
empty and the answer had landed in a sibling field; `Unexpected end of JSON input` did not say the
body was zero bytes behind a 200; a message that mentioned a quota in passing read as a rate limit to
the regex.

Each of the three defects diagnosed in this workspace needed the same set of facts, and none of them
was recorded at the time: which provider and model id was called, which upstream server answered,
the `finish_reason`, the body's byte length, which fields of the answer container were populated or
empty, and the top-level keys that arrived. So the seam now throws a **model-boundary failure**
carrying exactly those facts, under one of eight stable classifications — transport failure, request
timeout, HTTP error, empty body, unparseable body, upstream error, unusable shape, answer not JSON.
The classification is total: nothing crosses the seam unclassified, which is what makes a caller's
`switch` honest rather than a guess with a fallback.

The diagnostic records **shape only** — codes, keys, types, sizes, flags. Transcripts are private and
Source Items are untrusted third-party evidence, so neither may enter a durable log; Content Scout's
Source Adapter diagnostics already work this way and are the precedent and the quality bar. Two
consequences of that rule are worth naming because they look like omissions. The failure carries no
`cause`: a JSON parse error quotes the text it choked on, and a transport error can quote a URL
holding an API key. And it retains no body text, not even the 300-character excerpt the seam used to
put in a non-2xx message — a provider's validation error can echo the request back, and the request
contains a transcript. What survives from an error body is structural: its top-level keys, the
upstream server the provider named, and the numeric code it gave.

## Considered Options

- **Keep prose messages and give callers better regexes.** Rejected: the regex is the defect. A
  message is written for a person, so any change to its wording silently changes a retry decision,
  and a message that merely mentions a quota is indistinguishable from a quota refusal.
- **Add a `retryable` boolean to the failure and let the seam decide.** Rejected here: retry policy
  belongs to the Module, which knows what its Stage costs and how many attempts it has left. The
  seam's job is to report what happened. Recording the facts first is what lets the retry work land
  as its own change rather than as a guess baked into the seam.
- **Attach the underlying error as `cause` and sanitize it on the way into the log.** Rejected: it
  puts a payload-bearing object one property access away from every caller and makes the log the last
  line of defence. Not carrying the text is a stronger guarantee than carrying it carefully.
- **Reduce the upstream's free-text reason to a stable code, the way Source Adapter diagnostics do.**
  Not taken yet: the structured `code` and `provider_name` fields the providers already send are
  enough for the capacity classification that comes next, and an allowlist over provider prose is
  work with no caller asking for it.
- **Reuse Content Scout's diagnostic sanitizers rather than writing an allowlist here.** Rejected on
  direction: those live inside a Module, and the Shell's seam cannot depend on a Module it hosts. The
  precedent being followed is the approach — stable codes, allowlisted names, shape over content — not
  the code.
- **Define the failure in the server's LLM module rather than in the shared package.** Rejected: the
  Run detail view has to render these facts, so the classifications and the diagnostic are a contract
  between the server and the web app, exactly as `AdapterDiagnostic` is.

## Consequences

`CompleteJson` is unchanged. Callers that only propagate a failure need no change at all, and the one
caller that was matching strings — the Idea Engine's rate-limit back-off — now reads `status` and
`upstreamCode` off the diagnostic. `modelBoundaryDiagnostic(error)` returns the facts or `null`, so
a caller can tell a seam failure from its own validation error without inspecting a message.

Failure messages are now generated from the diagnostic and nowhere else, which makes them stable and
uninteresting to match: `provider: <what happened> (model …, binding …, HTTP …, N bytes, …)`. A
non-2xx failure says less than it used to, because the body excerpt is gone. That is the intended
trade: the status, the upstream name and the upstream code are the parts that were ever actionable.

The request ceiling `REQUEST_TIMEOUT_MS` is exported so that a test can drive it without waiting two
minutes. Nothing in production reads it yet: the Idea Engine still chooses its own Stage ceiling
independently, and reconciling the two is the retry work's, not this change's.
