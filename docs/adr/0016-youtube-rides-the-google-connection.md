# YouTube view counts ride the Google connection, not an API key

**Note (2026-08-31):** An insufficient-scope response does not distinguish a saved sign-in that
predates the scope from a consent screen that does not declare it. The operator is now told to sign
in again first and to check Data Access only if re-authentication does not resolve the refusal.

**Note (2026-08-24, correction):** an earlier draft of this ADR named `videos.batchGetStats` as
the statistics call and said it returns a `failedVideoIds` list. What is built calls `videos.list`
and derives the failed ids from the ids that did not come back. **The code is right and this ADR
was wrong**, for two reasons that were checked against Google's reference and against
`googleapis@175.0.0` rather than assumed:

- `batchGetStats` returns a `videoStat` resource, whose snippet carries **`publishTime` and nothing
  else**. It cannot supply a video's title, and `YoutubeVideoCount` in `packages/shared` records a
  title. Using it would mean two calls where there is now one.
- The `failedVideoIds` summary is documented on the reference page but **is not present in the
  installed client's response schema** (`Schema$BatchGetStatsResponse` carries `etag`, `items` and
  `kind` only). The single advantage that would have justified the switch is not reachable from
  here.

The method is real, it costs 1 unit, and it does state that authentication is not required for
public videos — so the API-key argument below stands unchanged. What does not stand is the
recommendation to read failures rather than derive them. One documented limit moves with it:
`batchGetStats` caps `id` at fifty explicitly, whereas `videos.list` documents no maximum for that
parameter, which is what the `STATISTICS_CHUNK` comment in
`apps/server/src/modules/youtube/client.ts` refers to.

**Note (2026-08-24):** this decision is unchanged by YouTube Trends as built. The Module also
writes the day's counts into a spreadsheet it creates for itself, and those writes need no further
scope: the full Drive scope this app already holds after ADR-0021 authorizes creating a spreadsheet
and writing values. So `youtube.readonly` remains the only consent change this Module forces, and
ADR-0021's scope reversal pays for itself here.

The Weekly YouTube View Count Module reads `videos.list` through the Google connection with a
fourth scope, `https://www.googleapis.com/auth/youtube.readonly`. It does not use an API key,
even though an API key would be sufficient: `videos.list` has no Authorization section and no
scope table in Google's reference, `videos.batchGetStats` states outright that authentication
is not required for public videos, and `statistics.viewCount` stays publicly visible even when
a channel sets `publicStatsViewable` to false. A key is the technically cheaper answer and it
was the recommendation put to the operator. It was rejected for a reason that outranks it.

The Google connection is already a hard dependency of the whole application. `drive.readonly`
powers the only transcript Intake there is (ADR-0012), so an unconfigured or expired
connection already means the app's main workflow is not running, which is already
unacceptable. A public-data read on that same connection therefore introduces no new way for
this Module to fail; it inherits a dependency the app has already accepted everywhere else.
The expiry that the API key was meant to dodge is not a new exposure either: `drive.readonly`
and `gmail.compose` are both restricted scopes under an External client in Testing, so the
weekly expiry is the app's normal condition rather than a fault (ADR-0013), and
`youtube.readonly` cannot make it worse. What the key *would* have introduced is the first
credential the Google connection does not hold, and with it a second secret store and a
second place to explain in Settings — against ADR-0011, which puts connection state in the
Shell, and against the plain shape of ADR-0007, where one person registers one OAuth client in
one Cloud project.

The change is an extension of machinery that already exists, not new machinery. `youtube`
joins `GOOGLE_SURFACES` in `apps/server/src/google/connection.ts` with
`{ label: "YouTube view counts", api: "YouTube Data API v3", scope: "youtube.readonly" }`, the
scope URL joins `GOOGLE_SCOPES` in `apps/server/src/google/oauth.ts`, and the scope-to-label
map gains its entry so a partial grant names the surface in human terms. The YouTube Data API
must be switched on explicitly, but it switches on in the same Cloud project that already
hosts Tasks, Gmail, Drive and Picker, so the setup card's API step goes from four APIs to five
and its scope step from "all three" to "all four". Unlike the Picker API, the YouTube Data API
has a server-side surface, so **Check my setup** can probe it exactly as it probes the other
three; no step is exempt this time.

An older connection that never granted the new scope keeps working for Tasks, Gmail and Drive
and needs no special handling. The first YouTube call fails with
`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `explainSurfaceFailure` already turns that into "The
consent screen is missing the youtube.readonly scope. Add it under Data Access, then sign in
again", and the connection classifies at the failure site as ADR-0008 requires. The operator
is told what to do by the mechanism that is already there.

## Considered Options

- **An API key on the same Cloud project.** Sufficient for public view counts, needs no
  consent screen change, no verification and no audit, and would leave existing connections
  untouched. Rejected: it becomes the app's first credential outside the Google connection,
  and it buys protection against an expiry the app already lives with by design.
- **A service account.** Unavailable. The YouTube Data API does not support the service
  account flow and answers `NoLinkedYouTubeAccount`, because a service account cannot be
  linked to a YouTube account. Recorded so that a later attempt to run this Module without a
  person's connection is not mistaken for an oversight.
- **A broader YouTube scope.** `videos.list` also accepts `youtube`, `youtube.force-ssl` and
  `youtubepartner`. Rejected: reading is all this Module does, and `youtube.readonly` is the
  narrowest of the four.

## Consequences

Every existing Google connection must consent once more, because a refresh token does not
acquire scopes granted after it was issued. This is the one real cost of the decision, it
lands in the Settings flow, and it is the same re-consent the Drive scope required when
ADR-0012 added it.

The Module cannot run without a connected Google connection. That is deliberate under this
ADR rather than incidental, and it means a weekly view-count refresh is skipped during an
expiry window rather than degrading to an unauthenticated read.

Quota is not a design constraint: `videos.list` costs 1 unit against a 10,000-unit daily
bucket, and it accepts a chunk of ids in that one call. The statistics read is `videos.list`, not
`videos.batchGetStats` — see the note below for why.

This decision settles nothing about credentials that are not Google's. HubSpot, Jotform and a
Google Chat webhook still have no home in the Shell, and the first Module to need one will
have to answer that question on its own terms.

`CONTEXT.md` describes the Google connection as the only route to a Google surface and names
Tasks, Gmail and Drive. That list gains YouTube when the scope ships, not before.
