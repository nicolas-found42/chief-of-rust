# People Terminal beta

Set `PEOPLE_TERMINAL=true` and recreate the app container to enable the
person workspace at `/terminal/people`. SQLite and the existing durable
worker remain the authority. Roll back the presentation by clearing the
flag. Keep the same workspace database and do not restore an older volume
over a deletion or revocation.

A Profile is the stable directory entry. A Dossier snapshot contains
assessed claims and anchors. A Brief selects findings from a saved person
scope; a Report selects findings that answer an independent question. The
artifact renderer reads the saved manifest and uses current access and
review state before serving content. Research and meeting outputs live
in separate record kinds. Meetings resolves an exact, unique attendee
email and uses the read-only person context projection; it owns its
copy of the version and citations. A context change invalidates its use
in a previously generated draft.

## Migration and operating scope

- Existing person IDs, research Runs, and legacy dossier revisions remain
  in place. The beta does not turn legacy prose or source wrappers into
  accepted facts. An eligible public original can be collected or inspected
  again; that produces a new dated snapshot. Missing earlier observation,
  publication, and effective dates are unknown.
- Search hits and returned collection envelopes are discovery leads.
  Operational outcomes are visible in Coverage and do not become source
  excerpts. The inspection pipeline screens original passages, checks
  identity against professional distinguishers, and checks entailment or
  contradiction after verifying an exact anchor. See
  [Jev integration notes](research/people-terminal-jev.md).
- The app has a single trusted Workspace operator. The person corpus is
  public professional evidence only; arbitrary uploaded text, pasted
  excerpts, and private sources are not beta inputs. Do not expose this
  installation as a multi-user public service. Do not treat observed
  provider or generated hints as confirmed present affiliations.
- Monitoring is opt-in. The worker checks at the selected cadence, admits
  bounded refresh Runs, and leaves the previous snapshot readable during
  collection. Pausing stops new scheduled work. An unchanged repeated
  observation does not create a new finding.
- Revocation suppresses the selected original and linked claims across
  current and historical beta reads. Profile deletion uses the existing
  privacy-delete path to remove person snapshots and dependent research
  artifacts, including queued generation. Exported or previously copied
  material and independently retained backups are outside the app's
  revocation boundary. Set backup expiry at deployment.

## Validation and release status

Use `cargo test -p chief-of-rust --test people_terminal --test meetings`
for the public HTTP and worker seams. The test data and judgment answers
are synthetic. A successful fixture tests application policy and the
shape/order of the judgment calls; it does not measure production model
accuracy. The PRD's operational, migration, and performance requirements
still need qualification against representative workspaces. Record
baseline task timings, citation adjudication, actual query and provider
costs, keyboard/zoom checks, and permission/deletion drills before
enabling the feature for a pilot.
