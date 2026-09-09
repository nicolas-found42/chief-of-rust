# Local-first, one instance per person

The app is a Found42 team app, so the obvious reading is a shared deployment the three of us log
into. We are deliberately not building that: each person runs their own instance against their own
Workspace and their own Google account, with no authentication and the server bound to
`127.0.0.1`. A shared instance would require real auth, per-user Google tokens, and per-user Run
isolation — weeks of work that buys nothing while the app is being designed.

## Consequences

Every security assumption in the app leans on "one trusted user on the loopback interface". If we
later host a shared instance — on the EdgeScale cube or anywhere else — that assumption breaks and
auth has to land before the first non-owner user, not after. Containerizing does not change this:
the container publishes to localhost only.
