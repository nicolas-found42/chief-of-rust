# Result Shape Binding follows the model, not the provider

ADR-0064 adds a narrow recovery exception for sustained repetition in an open answer stream.
ADR-0065 allows a caller to prefer a different binding that the model also declares supported.
ADR-0066 permits one observed same-binding retry within the original request deadline.

The Shell has one seam through which every Module asks a model for a Result Shape. Until now that
seam sent `response_format: {type: "json_schema", strict: true}` to every OpenAI-shaped provider and
read `choices[0].message.content`, stepping down to a prompt-only request only when a 4xx response
mentioned `json_schema`. Measured against the model this workspace runs — a reasoning model served
through OpenRouter — that path returned a usable answer roughly one call in three. Two Modules were
blocked on it: Content Scout could not propose a Brand Profile, and the Idea Engine could not finish
its last Stage.

The provider's own model metadata explains why, and the explanation is not about reasoning models.
The endpoint serving that model declares `tools` and `tool_choice` and does **not** declare
`response_format` or `structured_outputs`. The seam was sending a parameter the endpoint had never
claimed to support, and the answer arrived in whichever field the model chose. A forced tool call
against the same model returned a schema-conformant object on the first attempt.

So the binding is chosen from what the **model** declares, never from which provider fronts it.
The three bindings are ordered by how deterministic they are — provider-constrained decoding, then a
tool call the model is required to make, then asking in the prompt — and a model is sent the most
deterministic binding it declares support for. A weaker binding is used only where support is
unknown, and there the seam steps down one binding at a time on a refusal rather than dropping
straight to the prompt. OpenRouter's per-model endpoint declaration is the capability source and is
read once per model per process. OpenAI, Anthropic and Gemini keep their fixed bindings: their
mechanism is a property of the API, not of the model behind it. Ollama serves arbitrary local models
and has no declaration to read, so its support counts as unknown.

The same change stops the seam reporting a shape problem for a fault the provider named. A provider
may answer HTTP 200 and carry the failure in the body — `{"error": {"message": "Upstream error from
Nvidia: Service temporarily overloaded", "code": 502}}` was observed against the live endpoint — or
answer 200 with no body at all. Both used to surface as `unexpected chat-completion response shape`
or `Unexpected end of JSON input`. One shared payload parse now checks status, emptiness, parseability
and the error envelope for all five providers.

## Considered Options

- **Read `message.reasoning` when `content` is null.** Rejected: it treats the symptom. The answer
  landed outside `content` because the request asked for a binding the endpoint does not support,
  and the fallback would parse free-form reasoning prose as JSON while leaving the success rate at
  roughly one call in three.
- **Pin an upstream provider through OpenRouter's provider-routing field.** Rejected on fact: the
  model is served by exactly one upstream, so there is nothing to route to.
- **Change the model.** Rejected: the model was a deliberate choice, and the defect was in the
  request the seam built rather than in the model's ability to answer.
- **Hardcode a binding per provider — OpenRouter always forces a tool call.** Rejected: OpenRouter
  fronts hundreds of models and many of them do constrain decoding, which is the stronger guarantee.
  A provider-level rule would give those models the weaker binding forever.
- **Always try the strongest binding and fall back when the reply is unusable.** Rejected: a failed
  attempt against this model costs about 130 seconds, so a Run that steps down twice would spend
  over four minutes discovering something the provider will state on request. Trial-and-error also
  cannot distinguish "this model does not support it" from "this call happened to fail."
- **Extract capability lookup as its own module with its own seam.** Rejected: OpenRouter is the
  only capability source that exists. One adapter is a hypothetical seam, and it would widen the
  interface callers have to learn for no variation.

## Consequences

`CompleteJson` is unchanged: callers still pass a system prompt, a user prompt and their own Result
Shape. Binding selection, capability lookup, step-down and failure classification all sit behind
that one interface, so every Module gets the fix without knowing it happened.

An OpenRouter model costs one extra HTTP request the first time this process uses it. The result is
cached per model for the process lifetime — the Idea Engine makes 12 Stage calls against one model
and Content Scout ranks and then drafts, so a lookup per completion would have been a lookup per
Stage. The promise rather than the resolved value is cached, so concurrent Stages share one lookup.
What a model supports is not assumed to change mid-Run.

A model that declares neither binding is now sent a prompt-only request on the first attempt instead
of a rejected `response_format` request followed by a retry. That is one fewer call, and the failure
it can still produce is a weak-binding failure rather than a misleading rejection.

Failure messages from this seam now name the provider, the status, and the upstream reason where
one was given. They deliberately carry no payload text: transcripts are private and Source Items are
untrusted evidence, so diagnostics record shape — statuses, byte lengths, which field was populated —
and never content.
