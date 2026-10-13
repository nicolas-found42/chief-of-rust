# Chief of Staff — Found42

A local, single-user Chief of Staff, reimagined in Rust from
[chief-of-staff-demo](https://github.com/nicolas-found42/chief-of-staff-demo).
Five product areas share one SQLite Workspace and a server-rendered HTML app.
There is no TypeScript build or client application; normal links and forms
complete every workflow.

| Area | What you can do |
| --- | --- |
| Meeting Wizard | Create meetings or import Google Calendar; prepare briefs using canonical attendees and open Tasks; associate transcript evidence; review debriefs and action proposals; save weekly reviews; create reviewed Gmail drafts. |
| Content Engine | Maintain a brand and public-source watchlist; scout opportunities; develop revisioned projects with evidence, research, reviewed outlines, drafts and Markdown export. Nine publication formats are supported. |
| Content Research | Watch named people or subjects; save source-backed reports; collect YouTube channel observations and compare real measurement dates. |
| Person Profiles | Keep canonical identities, merge duplicates, maintain source excerpts, generate evidence-bound dossier revisions, capture exact-email HubSpot evidence, archive/restore or explicitly delete profile data. |
| Tasks | Capture and edit local work; use lists, priorities, due dates, status and Trash; accept reviewed meeting proposals; optionally link to Google Tasks or Asana. |

All live model workflows use **Mistral Large 4**, with the exact model ID
`mistral-large-4` and `MISTRAL_API_KEY` from the installation environment.
Structured content uses Mistral's schema mode to constrain citation IDs.
Dossier excerpts must match their cited source text exactly. Generated work
still waits for review; recorded source support does not establish that an
unverified public page describes the right person.

## Run it

Docker is the supported deployment. Your Mistral key can remain in the shell
where you start Compose, or in a local, gitignored `.env`. `.env.example`
contains the supported installation variables without secrets.

```sh
docker compose up -d --build --wait
```

Open [Chief of Staff](http://localhost:5317). The app publishes only on
`127.0.0.1:5317`; the existing TypeScript reference app can keep its own port
4317. SearXNG and Valkey run inside the Compose network. The app runs as an
unprivileged user and stores SQLite and its private Google token cache in the
persistent `chief-of-rust_workspace` Docker volume. `docker compose down`
stops the app and preserves this volume. Credentials are never committed or
served as Workspace preferences.

Local People, Tasks, meetings and content editing work without an account.
Missing credentials leave model or provider operations unavailable with a
recorded failure; the app does not substitute another model or sample output.
`LLM_PROVIDER=mock` is an explicitly selected offline test posture. It is
visible on the home page and is not a production fallback.

## Connections and schedules

In Settings, choose your name, IANA timezone, Calendar ID and transcript
folder. Every schedule starts disabled; enable the individual intake or
research intervals you want. Schedule admission and Run attempts survive
restarts, and a long-running worker renews its lease. A crashed worker's
expired lease is recoverable after at most ten minutes.

For Google, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for a **web OAuth
client**. Register this exact redirect URI:

```text
http://localhost:5317/google/callback
```

Enable the Calendar, Drive, Docs, Gmail, Tasks and YouTube APIs that you intend
to use, then connect from Settings. Native installations may instead use
`GOOGLE_CLIENT_SECRET_PATH` and a client JSON file. Sign-in state expires and
is single-use. Disconnect invalidates pending sign-ins. Queued Google work
keeps its account and connection generation; reconnecting another account
cannot redirect an old import or draft. The token cache is written atomically
with mode 600.

Calendar intake polls on demand or on its opt-in schedule. Drive intake
requires a selected folder and consent, reads text/plain files or native
Google Docs with transcript in the filename, and leaves new transcripts
unassigned until you confirm their meeting. Upload other transcripts as text.
Revoking folder consent fences queued and in-progress imports. Deleting an
imported transcript records an exclusion until you explicitly allow reimport.

Gmail actions create a reviewed draft addressed to your connected account;
the app has no mail-send operation. Set `ASANA_ACCESS_TOKEN` for optional Task
delivery and `HUBSPOT_ACCESS_TOKEN` for explicit contact evidence capture.
YouTube can use the connected Google account or `YOUTUBE_API_KEY`. Its
observations report their coverage; missing historical measurements are not
interpolated into growth claims.

Public-web research uses the first SearXNG result page, selecting up to eight
unique URLs with nonempty search snippets. Original pages are not fetched by
this path. Saved watch reports, project research and Person dossiers show
excluded results, the eight-source limit, snippet truncation at 6000 characters,
and unavailable search engines. Publication dates and current source accuracy
still require review. Empty source collections fail rather than producing a
report; a Person's saved evidence remains usable when optional search is empty.
Scout's direct public-page collection checks and pins DNS for each redirect;
it connects without a system proxy so the checked address remains the actual
destination.

## Records and review

Runs freeze their input and record each attempt. An explicit retry links a new
Run to the failed original. The completed record remains available. Edits to
identities, transcripts, meeting context, content evidence or outlines can
invalidate queued output; stale work cannot silently replace a newer record.

A debrief action remains a proposal until captured and accepted into Tasks.
Acceptance is atomic and idempotent. Accepted Tasks retain source snapshots
and survive deletion of their source. External task links are copies of local
work. If a remote create has an uncertain outcome, the app requires you to
check and reconcile it before another create. Gmail drafts follow the same
uncertainty boundary.

Content projects retain prior intent, evidence and artifact versions. A draft
belongs to the outline it used; replacing that outline requires another draft
and review before export. You can exclude evidence or edit generated copy by
creating a new version. Privacy deletion of a Person requires explicit
acknowledgment and purges that person's profile, source/dossier histories and
its profile-processing Run snapshots; accepted Tasks and meeting history
remain.

This is a fresh design and Workspace. It deliberately replaces the React SPA,
Node relay, multi-provider model selection and legacy migration/evaluation
surfaces with Rust forms, polling, one model and durable product records.
The reference repository remains available for the former implementation.

## Development and verification

```sh
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
docker compose build app
docker compose up -d --wait
python3 scripts/smoke.py http://127.0.0.1:5317
docker compose restart app
docker compose up -d --wait app
python3 scripts/smoke.py http://127.0.0.1:5317 --verify-persistence
```

The smoke script creates a Task named `Container persistence check`; run it in
an isolated verification Workspace. The ignored live acceptance tests use
scratch Workspaces and your existing Mistral key:

```sh
cargo test -p chief-of-rust --test live_mistral --locked -- --ignored
```

The ordinary suite uses deterministic providers and Wiremock. It reads durable
records and covers review, source lineage, stale writes, concurrent job
admission, lease recovery, failure/retry history, privacy deletion and the local
request boundary. Google/Asana/HubSpot/YouTube account verification requires
your own connections; passing offline tests does not claim those accounts are
connected.

CI runs `fmt`, `check`, `clippy`, `test` and `image`. Every change to `main`
lands through a PR and a squash merge bound to a head with all five checks
green. See `AGENTS.md` and `docs/agents/` for repository conventions.
