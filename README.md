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

Generated prose defaults to **Mistral Large 4** (`mistral-large-4`). Set
`LLM_PROVIDER` to choose a generation provider; failures never switch models.

| Provider | Model default | Reasoning | Credential |
| --- | --- | --- | --- |
| `mistral` | `mistral-large-4` | none | `MISTRAL_API_KEY` |
| `opencode` | `gpt-6-luna` | medium | `OPENCODE_API_KEY` |
| `zai` | `glm-5.3-flash` | low | `ZAI_API_KEY` |
| `ollama-cloud` | `deepseek-v4.1-flash` | high | `OLLAMA_CLOUD_API_KEY` |

All four support their own `*_MODEL`, `*_REASONING_EFFORT` and
`*_BASE_URL` overrides. OpenCode uses the Responses API for GPT models;
Z.AI and Ollama use Chat Completions. OpenCode defaults to its Go endpoint
and sends an honest app user agent plus a stable session per Run. Z.AI
defaults to its Coding Plan endpoint. For metered API accounts, override
`OPENCODE_BASE_URL=https://opencode.ai/inference/v1` or
`ZAI_BASE_URL=https://api.z.ai/api/paas/v4` explicitly. Z.AI uses JSON mode with the schema
in the prompt; the new adapters validate schema output locally before a
workflow can use it. Provider reasoning is never included in generated text.
Run attempts and content artifacts record the selected provider/model.

Settings lets you choose the generation provider and test all configured
connections without restarting Docker. After saving a generation provider,
choose its Model and Reasoning effort and click **Save model settings**.
Supported text models are listed for each adapter; incompatible effort/model
pairs are rejected. Each provider remembers its own overrides. Installation
default in either selector restores its environment value. Provider names,
model IDs and effort values are saved in the Workspace; keys and endpoints
remain server configuration.
New diagnostics and Runs resolve the saved choice when they start, while
in-flight work keeps its provider. Choices survive restarts. Select
**Installation default** to return to `LLM_PROVIDER`.
The model, search and Jev test buttons make small live calls and display
results or setup errors in the app.

Meeting debriefs also use **TypeSafe/Jev 1.14** through OpenRouter for
evidence judgments. `JEV_MODEL` defaults to `typesafe/jev-1.14` and
`JEV_BASE_URL` defaults to `https://openrouter.ai/api` (before
`/v1/systemone`). `JEV_API_KEY` takes precedence over `OPENROUTER_API_KEY`;
leave it empty to use your existing OpenRouter key. Native installations
also retain `TYPESAFE_BASE_URL` as a legacy alias when `JEV_BASE_URL` is unset.
All credentials stay in the installation environment. Live calls bill the
selected account. Structured content and debriefs retain citation checks.
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

## Meeting debriefs

Create a meeting, then paste a plain transcript or a Fireflies Markdown export
in the Transcript catalog and confirm its meeting association. Generate the
evidence-based debrief from the meeting page. The Run shows completed analysis
stages, failures and provider usage; refresh it while work runs in the background.

The saved debrief separates topics, settled decisions, new commitments, reported
completed work, unanswered questions, risks and tentative suggestions. Every
finding carries a verbatim quotation and links to the original transcript lines.
Text-only tone, interpersonal tension and transcript usability are judged per
segment, with probabilities and uncertainty available for review. Reported
completion can link to a confidently matched related Task; its status remains
under your control.

Fireflies generated summaries, generated action lists and metadata are excluded
from analysis. Only its `Sentences` dialogue is used. Plain transcripts retain
all nonempty lines. Analysis covers bounded overlapping segments and checks
consequential findings against every segment for contradictions, retractions or
answers. Source changes during generation prevent publication. The saved coverage
and limits describe what was processed; they do not guarantee extraction recall.

Uncertain, contradicted, duplicated or invalidly cited candidates remain visible
for review and cannot be captured as action proposals. Supported actions still
require your explicit capture and Task acceptance. Relative deadlines remain
quoted phrases until you assign a calendar date. No model judgment sends mail,
changes an existing Task's status or establishes that a reported event occurred.

Debriefs process up to four independent dialogue segments concurrently, then
run complete cross-source checks before saving an artifact. A separate Jev
judgment excludes commitments reported fulfilled from outstanding proposals,
without marking Tasks done. Set
`MEETING_SEGMENT_CONCURRENCY=1` in the server environment for serial operation,
or `2` for a lower provider load; the maximum is four. This changes scheduling,
not the model, evidence thresholds or source coverage. The saved timing report
distinguishes elapsed time from summed provider request durations. Providers
still apply their account-specific request and token limits; a failed segment
cancels pending work and fails the whole Run. Requests already received by a
provider may still incur charges after cancellation.

Missing Jev configuration disables debrief generation with setup guidance.
Provider errors, malformed judgments, screening flags and oversized inputs stop
the Run without substituting an unchecked debrief. A failed attempt retains its
completed stage evidence; retry creates a separate Run. Text-only mock posture
supports ordinary offline checks through explicit test fixtures.

See [the meeting teardown and experiment report](docs/meetings/teardown.md) for
measured behavior, costs, boundaries and replay commands.

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

Every public-web search calls all configured search services concurrently:
SearXNG when `SEARXNG_BASE_URL` is set (supplied by Docker), and Firecrawl
when `FIRECRAWL_API_KEY` is set. There is no search-provider selector;
legacy `SEARCH_PROVIDER` and saved search choices are ignored.
`FIRECRAWL_BASE_URL` overrides its API root. Per the
[Firecrawl v2 search docs](https://docs.firecrawl.dev/api-reference/endpoint/search),
we request web results with generated highlights disabled and no page scrape.
Results from each service are interleaved, then deduplicated and bounded
once across both services. A configured provider failure or Firecrawl
partial-coverage warning fails the search explicitly. SearXNG engine warnings
remain visible in coverage. Saved coverage records which services responded.
The combined result selects up to eight
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

## Provider acceptance checks

The opt-in provider suite sends small synthetic text/schema requests to each
model, a typed Jev judgment, and a Firecrawl search. It never prints keys or
raw provider responses. Run each independently, or the whole live suite:

```sh
cargo test -p chief-of-rust --test providers --locked -- --ignored --nocapture
```

The ordinary `providers` tests use Wiremock to verify model/reasoning request
shapes, local schema enforcement, credential precedence, redaction, search
limits and failure behavior without billing accounts. Live results establish
connectivity and these small contracts, not full workflow quality.
