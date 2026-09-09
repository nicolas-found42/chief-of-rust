# Each person supplies their own Notion integration token

Content Scout writes every Content Draft to a Notion content calendar, but this public, local-first
app has no server that can safely hold a shared Notion OAuth client secret. Each person therefore
creates an internal Notion integration, pastes its token into the Shell, and shares the relevant
database or parent page with it. The Shell owns the credential and connection state; Content Scout
lets the person connect an existing calendar or create a standard one, then owns the target and
property mapping. A Found42-hosted OAuth broker was rejected for the same reason ADR-0007 rejected
one for Google: it would introduce a service and shared secret solely to make a local app's setup
shorter.
