# Callers may prefer a declared Result Shape Binding

ADR-0029 normally selects the strongest binding the configured model declares. During issue
#228 diagnosis, a small retained document with the full dossier Result Shape repeatedly reached
the request ceiling under constrained decoding, while a controlled forced-tool request with that
same shape produced a grounded claim. A tiny one-field constrained-decoding request succeeded,
and a forced-tool judge request timed out: neither observation establishes a universal winning
binding or a provider-internal cause.

A caller may now prefer `forced_tool_call` for one request. The shared model boundary honors that
preference only for OpenRouter and only when the fetched model declaration contains both `tools`
and `tool_choice`. The original full Result Shape travels as the required tool's parameters, and
the answer is read from its arguments through the existing parser. Routing continues to require
support for the supplied parameters. Cached metadata remains the declaration, so one caller's
preference does not change another caller's default.

Without a preference, the strongest declared binding remains the default. Unsupported preferences
are ignored; unreadable metadata cannot establish support and retains the existing unknown-support
ladder. Other providers retain their existing binding policies. This preference neither changes
the configured model/provider nor weakens the caller's schema, and it is not learned from a failed
attempt or silently applied to every purpose.

The preferred declared binding remains final for ordinary timeouts and refusals. ADR-0066 permits
one observed retry on that same binding without relaxing this selection rule. ADR-0064's narrow
repetition recovery is unchanged and still shares the original request deadline. Binding-specific
diagnostics continue to describe the binding actually sent. Call sites need evidence for choosing
a preference; successful extraction is not evidence that a planning or judging request benefits
from the same choice.

The Person Research Benchmark also selects this declared preference for its semantic judges.
End-to-end smoke `39e8f583d614ad67` completed full-schema extraction, fact recovery and usefulness
assessment with tool responses on their first attempts. The previous response-format usefulness
request exhausted its deadline. These are different generated dossiers, so this establishes a
working candidate path, not a controlled claim of universal superiority or provider causation.
Judge version and binding preference are recorded and held fixed across comparison arms.
