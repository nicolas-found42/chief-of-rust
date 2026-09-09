# Binding recovery may step back up to a declared binding

ADR-0065 lets a caller prefer `forced_tool_call` among the bindings a model declares. That
preference starts recovery halfway down the ladder, and recovery only ever stepped downwards, so a
preferred tool call that failed went straight to prompt-only and skipped `response_format`
entirely — on a model that declared it. That is not a saving: on the routes that buffer a whole
tool call past the stream ceilings, `response_format` is the binding measured to stream
incrementally, and the skipped rung is what then burned the rest of a 300-second operation.

Recovery now walks every rung below the chosen binding, as before, and also any rung above it that
the model's declaration covers. The chosen binding still goes first, so a preference remains a
preference rather than a ceiling.

A binding the declaration does not cover is never stepped up to. `readDeclaredParameters` unions
the declarations of every endpoint, so an absence there is an absence everywhere, and a call spent
proving it is a call spent for nothing. This leaves ADR-0064's rule intact in the other direction:
a declared binding is still final for a refusal, and it is observed degeneration, a routing
refusal, or an ignored tool choice that permits recovery at all.
