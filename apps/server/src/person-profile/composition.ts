import type {
  PersonDossier,
  PersonProfile,
  PersonResearchAttempt,
  PersonResearchCoverageArea,
  PersonResearchOperationOutcome,
  PersonSourceDocument,
} from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../llm/providers.js";
import type { PublicSearch } from "../source-adapters/search.js";
import { createFeedDiscoverer } from "../source-adapters/feeds.js";
import { publicHttpFetchBytes, type PublicHttpBytesFetch } from "../source-adapters/http.js";
import type { BrowserRenderer } from "../source-adapters/browser.js";
import type { TranscriptConsumerRegistry } from "../transcript-catalog/deletion.js";
import type { PersonProfileCreateInput } from "@chief-of-staff-demo/shared";
import { createPersonClaimExtractor } from "./claims.js";
import { PersonDossierStore } from "./dossier-store.js";
import { personDossierRegistry } from "./lifecycle.js";
import { WorkspacePersonProfiles, type PersonProfileLifecycleRegistry } from "./profiles.js";
import { PersonResearch } from "./research.js";
import { PersonResearchQueue } from "./research-queue.js";
import { PersonProfileResolver } from "./resolver.js";
import { createPublicWebPersonProfileSource } from "./sources.js";
import { PersonProfileStore } from "./store.js";
import { WorkspacePersonProfileTranscriptEvidence } from "./transcript-evidence.js";

/**
 * One Transcript a Person Profile is confirmed in.
 *
 * Deliberately not named for Person Evidence or a Person Source Document:
 * it is neither. Those are what research *produces* about a person; this is
 * a Transcript a Confirmed Identity Decision points at, before any of it is
 * read.
 *
 * One entry per Confirmed Identity Decision rather than per Transcript. That
 * granularity is load-bearing: the research queue's evidence revision is
 * derived from this list, so collapsing two decisions that name the same
 * Transcript would change every stored revision at once and re-research the
 * whole Workspace for nothing.
 */
export interface ConfirmedTranscript {
  transcriptId: string;
  fileName: string;
  text: string;
  /** The bytes the decision was made against; a re-ingest changes it. */
  checksum: string;
}

/**
 * Remote I/O the hermetic browser suite replaces, leaving the pipeline intact.
 * Derived from what it is spread into rather than restated, so the two cannot
 * drift apart.
 */
type PersonResearchTestPorts = Partial<
  Pick<
    ConstructorParameters<typeof PersonResearch>[0],
    "search" | "fetch" | "fetchBytes" | "render" | "complete" | "plan" | "readSource" | "seeds"
  >
>;

/**
 * The operation-level research interface (issue #228).
 *
 * One handle for everything a consumer needs from a continuous research
 * operation — start it, read what it has published so far, and read its final
 * outcome, coverage and full attempt history — with the collectors, the
 * scheduler and the dossier store behind it. The benchmark evaluator is a
 * consumer of exactly this, which is what keeps it from growing a second
 * discovery or extraction implementation of its own.
 */
interface PersonResearchOperations {
  /** Create or reuse the canonical Person Profile and queue an operation. */
  startFor(signals: PersonProfileCreateInput): PersonProfile;
  /** Run the pending operation for this Profile through to its conclusion. */
  runNow(profileId: string): Promise<PersonResearchOperationOutcome | null>;
  /** The dossier as published so far. Readable while research continues. */
  dossier(profileId: string, visibility?: "public" | "private"): PersonDossier | null;
  /** Every retained source version this Profile's dossier names. */
  sources(profileId: string): PersonSourceDocument[];
  /** The last operation's durable record, or null before one has finished. */
  outcome(profileId: string): PersonResearchOperationOutcome | null;
  coverage(profileId: string): PersonResearchCoverageArea[];
  /** The complete attempt history, never the display slice. */
  attempts(profileId: string): PersonResearchAttempt[];
}

/**
 * What the Shell hands the Person Profiles product, and nothing more: a
 * Workspace directory, the shared outward surfaces, and the questions only
 * the Shell can answer. What the product *builds* — both stores, the
 * Workspace interface, the research pipeline, the queue, the resolver and the
 * transcript-deletion registrations — is its own, even where the handle
 * hands a store back for the Shell to name and route.
 */
export interface PersonProfilesCompositionDeps {
  workspaceDir: string;
  /**
   * The app-wide PublicSearch. Shared rather than built here: one home IP
   * shares every provider's rate limits, so the query cache and the
   * per-provider cooldowns have to span every consumer.
   */
  search: PublicSearch;
  /** Model access, read per call so a Settings edit lands without a restart. */
  complete: () => CompleteJson;
  /**
   * The research planner's model access, on its own Settings purpose. Absent
   * means the operation expands from collected evidence only.
   */
  plan?: () => CompleteJson;
  /**
   * The Transcripts this Person Profile is confirmed in. The Catalog owns
   * what "confirmed" means (`TranscriptIdentityService.confirmedMentions`);
   * this product only asks.
   */
  confirmedTranscripts: (profileId: string) => ConfirmedTranscript[];
  /**
   * Whether that exact Transcript is still confirmed and still those bytes.
   *
   * Separate from the listing above, and not derivable from it cheaply:
   * research asks this per result inside a loop, while the listing reads
   * every confirmed Transcript's full text. Answering the one from the other
   * would read the whole corpus once per result.
   */
  transcriptStillConfirmed: (profileId: string, transcriptId: string, checksum: string) => boolean;
  /**
   * Lifecycle registries belonging to other products — the Shell's own
   * Profile references and Content Research's watches. The dossier registry
   * is this product's own and is added below.
   */
  lifecycle?: PersonProfileLifecycleRegistry[];
  /**
   * The bounded anonymous browser route, for pages that only render their
   * content client-side. Absent means that recovery route is unavailable and
   * a client-rendered page is recorded as a gap rather than silently skipped.
   */
  render?: BrowserRenderer;
  /** Whether research may dispatch at all; false while the migration gate holds. */
  researchEnabled: () => boolean;
  /** Lowercased participant emails of the Meetings close enough to prepare for. */
  upcomingParticipantEmails?: () => string[];
  /** Present only in the hermetic browser suite; the Shell decides that. */
  researchTestPorts?: PersonResearchTestPorts;
}

/** The Person Profiles product as one handle. Routes stay with the Shell. */
export interface PersonProfilesComposition {
  /** The durable records. The resolver and the evidence registry read it. */
  store: PersonProfileStore;
  /** The Workspace-owned interface every other product holds (spec #117). */
  profiles: WorkspacePersonProfiles;
  dossiers: PersonDossierStore;
  queue: PersonResearchQueue;
  /** The operation-level research interface every consumer holds (#228). */
  research: PersonResearchOperations;
  resolver: PersonProfileResolver;
  /**
   * This product's two registrations into transcript deletion (issue #128):
   * transcript-origin Person Evidence, and dossier claims cited to a
   * Transcript. Registered by the Shell alongside every other consumer's.
   */
  transcriptConsumers: TranscriptConsumerRegistry[];
  start(): void;
  stop(): void;
  drain(): Promise<void>;
}

/**
 * Compose the Person Profiles product.
 *
 * This graph used to be written inline in `composeShell`, across twelve
 * imports and roughly 180 lines — including the walk that decided which
 * Transcripts counted as evidence, which is the Catalog's question and now
 * arrives as one dependency. The Shell holds a handle rather than the graph,
 * so an internal seam here stops being a change to the composition root
 * (the same shape `composeTasks` already has).
 */
export function composePersonProfiles(
  deps: PersonProfilesCompositionDeps,
): PersonProfilesComposition {
  const store = new PersonProfileStore(deps.workspaceDir);
  const dossiers = new PersonDossierStore(deps.workspaceDir);

  /* The dossier registry needs the queue, and the queue needs the Profiles
     the registry is attached to. The Shell resolved that with a closure over
     a later binding; it stays a closure, but it is now internal to the one
     module that owns both ends of it. */
  const profiles = new WorkspacePersonProfiles({
    store,
    dossiers,
    lifecycle: [
      ...(deps.lifecycle ?? []),
      personDossierRegistry(dossiers, (profileId) => queue.remove(profileId)),
    ],
  });

  /* The document reader needs bytes, not a UTF-8 decode, and the hermetic
     suites inject only the text transport. Deriving the byte transport from
     an injected text one keeps those suites off the network while the real
     byte transport stays the default for production. */
  const injectedFetch = deps.researchTestPorts?.fetch;
  const fetchBytes: PublicHttpBytesFetch =
    deps.researchTestPorts?.fetchBytes ??
    (injectedFetch
      ? async (url, options) => {
          const response = await injectedFetch(url, options);
          return {
            url: response.url,
            status: response.status,
            contentType: response.contentType,
            retryAfter: response.retryAfter,
            bytes: Buffer.from(response.body, "utf8"),
          };
        }
      : publicHttpFetchBytes);

  const research = new PersonResearch({
    dossiers,
    people: profiles,
    search: deps.search,
    complete: (request) => deps.complete()(request),
    operationModels: () => {
      const plan = deps.researchTestPorts?.plan ?? deps.plan?.();
      return {
        complete: deps.researchTestPorts?.complete ?? deps.complete(),
        ...(plan ? { plan } : {}),
      };
    },
    /* The planner runs on its own configured purpose, so a Workspace can give
       planning a different model from extraction without either becoming the
       other's fallback. When no planner is configured the operation expands
       from the collected evidence alone. */
    ...(deps.plan ? { plan: (request) => deps.plan!()(request) } : {}),
    ...(deps.render ? { render: deps.render } : {}),
    fetchBytes,
    /**
     * The Transcripts research may read. One document per Transcript however
     * many decisions named it — the confirmed list is per decision, the
     * reading list is not.
     *
     * The order is the Catalog's `confirmedMentions` order (Transcript, then
     * mention), which matters because research reads only the first eight.
     * The wiring this replaced took them in `readdirSync` order, so which
     * eight were researched depended on the filesystem; this is a change from
     * an unspecified selection to a specified one.
     */
    privateDocuments: (profile) => {
      const seen = new Set<string>();
      return deps.confirmedTranscripts(profile.id).flatMap((confirmed) => {
        if (seen.has(confirmed.transcriptId)) return [];
        seen.add(confirmed.transcriptId);
        return [
          {
            transcriptId: confirmed.transcriptId,
            title: confirmed.fileName,
            text: confirmed.text,
            /* Asked again per result once the research runs: the Transcript's
               bytes must still match and the decision must still stand. */
            active: () =>
              deps.transcriptStillConfirmed(profile.id, confirmed.transcriptId, confirmed.checksum),
          },
        ];
      });
    },
    ...(deps.researchTestPorts ?? {}),
  });

  const queue = new PersonResearchQueue({
    workspaceDir: deps.workspaceDir,
    people: profiles,
    research,
    enabled: deps.researchEnabled,
    /* One pair per Confirmed Identity Decision, in the order the Catalog
       promises — so the revision is stable by construction rather than by a
       sort applied here. */
    evidenceRevision: (profileId) =>
      JSON.stringify(
        deps
          .confirmedTranscripts(profileId)
          .map((confirmed) => [confirmed.transcriptId, confirmed.checksum]),
      ),
    upcomingProfileIds: () => {
      const emails = new Set(deps.upcomingParticipantEmails?.() ?? []);
      if (emails.size === 0) return [];
      return profiles
        .search()
        .filter((person) => person.emails.some((email) => emails.has(email)))
        .map((person) => person.id);
    },
  });

  const operations: PersonResearchOperations = {
    startFor: (signals) => {
      const profile = profiles.create(signals);
      queue.enqueue(profile.id, "explicit");
      return profile;
    },
    runNow: async (profileId) => {
      queue.enqueue(profileId, "explicit");
      await queue.tick(profileId);
      return queue.operation(profileId);
    },
    dossier: (profileId, visibility = "private") => dossiers.project(profileId, visibility),
    sources: (profileId) =>
      (dossiers.get(profileId)?.sourceIds ?? []).flatMap((id) => {
        const source = dossiers.source(profileId, id);
        return source ? [source] : [];
      }),
    outcome: (profileId) => queue.operation(profileId),
    coverage: (profileId) => queue.operation(profileId)?.coverage ?? [],
    attempts: (profileId) => queue.operation(profileId)?.attempts ?? [],
  };

  const resolver = new PersonProfileResolver({
    store,
    sources: [
      createPublicWebPersonProfileSource({
        search: deps.search,
        discoverFeeds: createFeedDiscoverer(),
        extractClaims: createPersonClaimExtractor(deps.complete),
      }),
    ],
  });

  const transcriptConsumers: TranscriptConsumerRegistry[] = [
    new WorkspacePersonProfileTranscriptEvidence(store),
    {
      consumer: "person-dossiers",
      label: "Dossier claims and interpretations",
      inspect: (record) =>
        profiles
          .search({ includeArchived: true })
          .reduce(
            (count, profile) =>
              count +
              (dossiers
                .get(profile.id)
                ?.claims.filter((claim) =>
                  claim.citations.some(
                    (citation) =>
                      dossiers.source(profile.id, citation.sourceId)?.transcriptId === record.id,
                  ),
                ).length ?? 0),
            0,
          ),
      purge: (transcriptId) => {
        /* The purge count is what the Transcript's removal actually cost the
           dossiers, so it is the same census taken on both sides of the call. */
        const claimCensus = () =>
          profiles
            .search({ includeArchived: true })
            .reduce((count, profile) => count + (dossiers.get(profile.id)?.claims.length ?? 0), 0);
        const before = claimCensus();
        dossiers.removeTranscript(transcriptId);
        return before - claimCensus();
      },
    },
  ];

  return {
    store,
    profiles,
    dossiers,
    queue,
    research: operations,
    resolver,
    transcriptConsumers,
    start: () => queue.start(),
    stop: () => queue.stop(),
    drain: () => queue.drain(),
  };
}
