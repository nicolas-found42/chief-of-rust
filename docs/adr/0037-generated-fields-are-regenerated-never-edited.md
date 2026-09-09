# Generated fields are regenerated, never edited

The Executive Assistant shows a person their Meeting Debrief before anything is written outward, and
the only changes they can make to it are to regenerate a field or to drop an individual action item.
There is no character-level editing anywhere in that review, and the app is deliberately not a text
editor.

The reason is that a Meeting Debrief is structured data, not prose. Its fields are what become the
Gmail draft body and what become Google Tasks, so the moment a person can retype the rendered email,
the thing they sent and the thing the app holds are two different artifacts — and the Tasks would be
written from the one they did not read. Editing the fields instead keeps a single source, and there
is less lost than it first appears: decisions, action items, open questions and coaching advice are
short list items rather than paragraphs, and the free-text `summary` field is where any long-form
rewording already belongs.

## Considered options

- **Edit the rendered email body, keep the structure as a shadow copy.** Rejected: this is exactly
  the "parse generated prose back into fields" problem the Executive Assistant was specified to
  avoid, and it silently desynchronises delivery from action items.
- **Edit the structured fields character by character.** Rejected as the narrower call of the two:
  it keeps one source and would work, but it makes the app own prose quality, and every field then
  needs validation, length rules and an editing surface. Regeneration puts the writing back with the
  model and leaves the person with the two judgements they are actually better at — "this is wrong,
  try again" and "drop this one".

## Consequences

A regeneration cannot see the value it replaces, because it shares the immutable input every other
generation of that debrief used. Content Scout already settled this shape: its Opportunity Brief is
"the immutable input shared by all independent Content Draft generations", and it carries "no sibling
Content Drafts" precisely so one generation cannot see another. So regenerating may return the same
answer, which is accepted: the alternative is telling the model to avoid what it just said, which
biases it toward novelty over accuracy, and accuracy is the whole point when the source is a
transcript of what people actually decided.

It follows that regenerating a field discards the review decisions on that field. Dropped action
items cannot survive a regeneration of the action items, because the new list has no stable identity
to map the drops onto, and carrying them across would drop a different item invisibly. The review
surface has to say so before the regeneration happens.

A regeneration is a model call that can fail, so it runs inside a Stage rather than beside the Run —
ADR-0030 makes a model-boundary failure a classified fact, and a call outside a Stage has nowhere to
put one. A heavily reviewed Run therefore accumulates a Stage per regeneration, which is an accurate
record of what happened rather than noise to be hidden.
