# Each person registers their own Google OAuth client

Every consumer app ships one OAuth client and offers a Sign in with Google button that just works,
so that is what a new user expects here. We cannot do it: this repository is public, a committed
client secret is caught by secret scanning and revoked, and there is no server to hold one because
the app is local-first and single-user (ADR-0001). Each person therefore registers their own OAuth
client in their own Google Cloud project, and the four one-time console steps — enable the Tasks
and Gmail APIs, configure the consent screen, create the client, paste the credentials — are
spelled out in the Settings page beside the exact strings they need, rather than in a README the
user has to hold in their head while tabbing through a console.

The consent screen has to be user type **External**, because Nicolas signs in with a Workspace
account and the app must also serve personal Google accounts, and **Internal** admits only the
organisation's own. External plus a publishing status of Testing is the only combination available
without Google's verification review, which the Gmail scope would require. Google expires a
refresh token issued under it after seven days.

## Considered Options

- **A Found42-owned client shipped in the image**, with the secret supplied out of band in a
  gitignored `.env`. One click for the three of us, nothing for anyone cloning the public repo, and
  a secret that leaks the moment someone commits their environment file.
- **An Internal consent screen** on the found42.com Workspace: no verification, no test-user list,
  no seven-day expiry — and no personal Google accounts, which rules it out.
- **A hosted token broker** holding the secret server-side. Contradicts ADR-0001 and is a service
  to run and secure for a three-person local app.
- **A Desktop-app client type**, which would have freed the redirect URI from the exact port. Its
  redirect URIs must still be pre-registered and Google documents no path component for the
  loopback flow, so it buys nothing and the client stays a Web application.

## Consequences

The seven-day expiry is not a failure mode, it is the normal weekly state, so the Shell models the
Google connection as four states — unconfigured, disconnected, connected, expired — and proves the
stored token by spending it rather than inferring a connection from three non-empty strings. The
previous boolean reported a rejected token as connected with no email, which sent the next Run to a
failure the Shell already had the information to name. Anyone who wants to be rid of the weekly
re-signin has to publish their consent screen and submit to Google's verification for the Gmail
scope; that is their project's decision to make, not this app's.

Because the redirect URI is `http://localhost:<port>/api/google/callback` and Google matches it
character for character, the port stays load-bearing (`docker-compose.yml`, `PORT`). The URI is now
derived from the port the server is listening on and served to the UI, so the value the user is
told to register cannot drift from the one the server will send.
