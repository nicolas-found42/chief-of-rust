# Upcoming meetings wait in Intake, not Runs

Google Calendar push can report an event long before the Meeting Brief Generator should prepare
it. The Intake therefore keeps the upcoming event and asks the Shell's durable clock to wake it at
the preparation time; it creates a Run only when enrichment is due. Creating a `blocked` Run as a
calendar placeholder was rejected because future meetings would occupy the Runs list for days or
months even though no Module work had begun.

## Consequences

The Shell's durable clock must support a Module-owned scheduled wake-up outside a Run, extending the
Run-only clock wait built for ADR-0020. The scheduled record must survive restart, be unique by
Module and Calendar event identity, and let the Intake replace or remove it when an event moves,
becomes ineligible or is cancelled.
