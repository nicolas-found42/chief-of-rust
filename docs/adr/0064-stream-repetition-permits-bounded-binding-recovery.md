# Stream repetition permits bounded binding recovery

This narrows ADR-0029's rule that a declared Result Shape Binding is final. An open answer
stream that repeatedly emits the same short text can now fail as `repetition_loop` and try the
next binding, including when the provider declared the original binding. Capability metadata
still chooses the first request; repetition is a recovery signal for this attempt, not a claim
that the model never supports that binding.

The failed stream is aborted before recovery. Every attempt shares the original absolute request
deadline, keeps the configured model and the caller's full Result Shape, and returns through the
same validation path. A finished answer remains subject to ordinary parsing and validation.
No answer text or hidden reasoning is retained in diagnostics.

Byte volume and elapsed time alone do not establish repetition. An early fallback based on those
two measurements discarded a valid varied answer in a deterministic streaming regression and was
removed. Transport failures, ordinary timeouts, and declared-binding refusals do not gain a new
fallback from this exception. A repetitive final binding reports its failure honestly.

The repetition detector is a bounded heuristic, not proof about the provider's internal cause.
It trades an early retry of a strongly repetitive open answer against waiting for the entire
request ceiling. Live acceptance remains separate: this recovery does not by itself establish
that Person Research completes or recovers the benchmark references.
