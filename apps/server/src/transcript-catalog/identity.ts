import { createHash } from "node:crypto";
import type {
  IdentityDecision,
  OrganizationMention,
  OrganizationMergeDecision,
  PersonProfile,
  RememberedMapping,
  TranscriptMatchCandidate,
  TranscriptMention,
  TranscriptRecord,
  TranscriptReviewQueue,
} from "@chief-of-staff-demo/shared";
import { isDerivedIdentityDecision } from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import {
  extractMentions,
  IDENTITY_MINING_ALGORITHM_VERSION,
  normalizeName,
} from "./identity-extraction.js";
import {
  candidateSignals,
  conflictsFor,
  mappingResolutionFor,
  policyClassOf,
  profileIdentifiersOf,
} from "./identity-matching.js";
import { type TranscriptIdentityMeta, TranscriptIdentityStore } from "./identity-store.js";

/* The mining algorithm's version stamps every mention, candidate and decision
   this service writes, so it is read from the service rather than from the
   extraction internals it happens to live in (#166). */
export { IDENTITY_MINING_ALGORITHM_VERSION } from "./identity-extraction.js";

export interface TranscriptIdentityDeps {
  store: TranscriptIdentityStore;
  people: WorkspacePersonProfiles;
  now?: () => Date;
  automaticCreation?: boolean;
}

class UnknownMentionError extends Error {
  constructor(mentionId: string) {
    super(`Unknown mention: ${mentionId}`);
    this.name = "UnknownMentionError";
  }
}

class InvalidDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDecisionError";
  }
}

export interface DecideInput {
  mentionId: string;
  action: IdentityDecision["action"];
  profileId?: string;
  fullName?: string;
  primaryEmail?: string;
  scope?: RememberedMapping["scope"];
  note?: string;
}

export interface MergeOrganizationsInput {
  sourceOrganizationMentionId: string;
  targetOrganizationMentionId: string;
  note?: string;
}

/**
 * One Transcript Mention this service has confirmed against a Person Profile.
 * It names the Transcript rather than carrying it: what the Transcript says,
 * when it happened and whether its bytes still match are the Catalog store's
 * answers, and the callers that need them already hold it.
 */
export interface ConfirmedMention {
  transcriptId: string;
  mentionId: string;
  /** The preserved span the decision was made on. */
  quote: string;
}

/** Everything mined from one Transcript, for a consumer that reviews it whole. */
export interface TranscriptIdentityReview {
  mentions: TranscriptMention[];
  decisions: IdentityDecision[];
  organizations: OrganizationMention[];
}

/**
 * The outcomes that make a Transcript evidence for a Person Profile — a
 * Confirmed Identity Decision. Deliberately not exported: a caller holding
 * this set would be one `readMentions()` away from re-deriving the walk
 * `confirmedMentions` exists to own.
 */
const CONFIRMED_OUTCOMES = new Set<IdentityDecision["outcome"]>(["linked", "created"]);

/**
 * Identity mining over the Transcript Catalog (issue #126). Deterministic
 * recognition over the immutable Transcript is the whole of mining: extraction
 * is an implementation detail of this service rather than an adapter seam, and
 * the service persists mentions, Organization Mentions, and explainable
 * candidates. Only a non-conflicting exact stable identifier
 * may auto-link to an EXISTING Profile. Remembered mappings apply as explicit
 * owner authority, and no processing path creates a Person Profile; explicit
 * review does.
 */
export class TranscriptIdentityService {
  private readonly store: TranscriptIdentityStore;
  private readonly people: WorkspacePersonProfiles;
  private readonly now: () => Date;
  private readonly automaticCreation: boolean;

  constructor(deps: TranscriptIdentityDeps) {
    this.automaticCreation = deps.automaticCreation ?? false;
    this.store = deps.store;
    this.people = deps.people;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Forget everything mined from one Transcript. Used when the Catalog
   * retires a copy of a recording it already holds: the mentions belong to
   * the record, so they go with it rather than surviving as candidates
   * nobody can trace back to a transcript.
   */
  forget(transcriptId: string): void {
    this.store.forgetTranscript(transcriptId);
  }

  async backfill(records: TranscriptRecord[]): Promise<void> {
    for (const record of records) await this.process(record);
  }

  /**
   * Mine one Transcript. Extraction runs only when the inputs it actually
   * consumes changed; matching then runs unconditionally, so a Transcript
   * whose text is untouched still picks up today's Person Profiles.
   */
  async process(record: TranscriptRecord): Promise<void> {
    const extractionVersion = this.extractionVersion(record);
    if (!this.store.wasProcessed(record.id, IDENTITY_MINING_ALGORITHM_VERSION, extractionVersion)) {
      this.extract(record, extractionVersion);
    }
    this.rematchTranscript(record.id);
  }

  /**
   * Re-derive candidates and every derived outcome across the mined corpus
   * against identity as it stands now. Person Profile creation, correction,
   * merge, detach/split, invalidation and archiving all change what a mention
   * matches, so an auto-link is a standing judgment, not a first sighting.
   * Idempotent: unchanged inputs append nothing.
   */
  rematch(): void {
    for (const transcriptId of Object.keys(this.store.readTranscriptMeta())) {
      this.rematchTranscript(transcriptId);
    }
  }

  /**
   * Derived-input version for the extraction ledger: exactly what
   * `extractMentions` consumes. A Profile's known URLs belong here because
   * canonicalization consults them; every other Profile fact drives matching,
   * not extraction, and must not cost re-mining.
   */
  private extractionVersion(record: TranscriptRecord): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          checksum: record.source.checksum,
          speakerIdentityMappings: record.speakerIdentityMappings,
          roster: record.roster,
          knownProfileUrls: this.knownProfileUrls(),
        }),
      )
      .digest("hex");
  }

  /**
   * The Profiles a mention may match. A merged-away Profile keeps its
   * revisions as an audit record but owns no current identity, so it is
   * neither a candidate nor a duplicate owner of the survivor's identifiers.
   */
  private matchableProfiles(): PersonProfile[] {
    return this.people
      .search({ includeArchived: true })
      .filter((profile) => profile.mergedInto === undefined);
  }

  private knownProfileUrls(): string[] {
    return [...new Set(this.matchableProfiles().flatMap((profile) => profile.profileUrls))].sort();
  }

  private extract(record: TranscriptRecord, extractionVersion: string): void {
    const { mentions, organizations } = extractMentions(record, {
      knownProfileUrls: this.knownProfileUrls(),
    });
    this.store.saveTranscriptMeta(record.id, {
      fileName: record.source.fileName,
      meetingDate: record.meetingDate,
    } satisfies TranscriptIdentityMeta);
    this.store.replaceMentions(record.id, mentions);
    this.store.replaceOrganizations(record.id, organizations);
    this.store.markProcessed({
      transcriptId: record.id,
      algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
      extractionVersion,
      processedAt: this.now().toISOString(),
    });
  }

  /** Score every mention of one Transcript again and settle its outcome. */
  private rematchTranscript(transcriptId: string): void {
    const mentions = this.store
      .readMentions()
      .filter((mention) => mention.provenance.transcriptId === transcriptId);
    if (this.automaticCreation) {
      const allMentions = this.store.readMentions();
      for (const mention of mentions) {
        if (mention.kind !== "person") continue;
        const current = this.store.latestDecision(mention.id);
        if (current && !isDerivedIdentityDecision(current)) continue;
        const emails = [
          ...new Set([
            ...mention.emails,
            ...(mention.speakerCalendarEmail ? [mention.speakerCalendarEmail] : []),
          ]),
        ];
        const identifiers = emails.length ? emails : mention.profileUrls;
        if (identifiers.length !== 1) continue;
        const identifier = identifiers[0]!;
        const rejectedElsewhere = allMentions.some(
          (other) =>
            (other.emails.includes(identifier) || other.profileUrls.includes(identifier)) &&
            ["not-a-person", "unresolved"].includes(
              this.store.latestDecision(other.id)?.action ?? "",
            ),
        );
        if (rejectedElsewhere) continue;
        try {
          this.people.ensureIdentifier(identifier);
        } catch {
          /* Conflicts, archives and tombstones stay in the review lane. */
        }
      }
    }
    const profiles = this.matchableProfiles();
    const mappings = this.store.readMappings();
    const generatedAt = this.now().toISOString();
    const candidates: TranscriptMatchCandidate[] = [];
    const profileIdentifiers = profileIdentifiersOf(profiles);

    for (const mention of mentions) {
      if (mention.kind !== "person" && mention.kind !== "ambiguous-name") continue;
      const mapping = mappingResolutionFor(mappings, transcriptId, mention.normalizedForms);
      const scored = profiles
        .map((profile) => {
          const signals = candidateSignals(mention, profile, mapping);
          const score = signals.filter((s) => s.matched).reduce((total, s) => total + s.weight, 0);
          return {
            profile,
            signals,
            score,
            conflicts: conflictsFor(mention, profile, profiles, profileIdentifiers),
          };
        })
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.profile.id.localeCompare(right.profile.id),
        );

      scored.forEach((entry, index) => {
        const next = scored[index + 1];
        const leadOverNext = next === undefined ? null : entry.score - next.score;
        candidates.push({
          id: `tc_${createHash("sha1").update(`${mention.id}|${entry.profile.id}`).digest("hex").slice(0, 12)}`,
          mentionId: mention.id,
          transcriptId,
          profileId: entry.profile.id,
          policyClass: policyClassOf(
            mention,
            entry.signals,
            entry.conflicts,
            leadOverNext,
            index === 0,
          ),
          score: entry.score,
          leadOverNext,
          signals: entry.signals,
          conflicts: entry.conflicts,
          evidence: [
            {
              quote: mention.provenance.quote,
              spanStart: mention.provenance.spanStart,
              spanEnd: mention.provenance.spanEnd,
              timestamp: mention.provenance.timestamp,
              speakerLabel: mention.provenance.speakerLabel,
            },
          ],
          algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
          generatedAt,
        });
      });
    }

    this.store.replaceCandidates(transcriptId, candidates);
    for (const mention of mentions) {
      this.settle(mention, candidates, mappings, generatedAt);
    }
  }

  /**
   * One mention's current outcome. An owner review decision is authority and
   * is only repaired to follow identity repair; a derived decision — a policy
   * auto-link or a remembered-mapping application — is recomputed, and
   * withdrawn to unresolved once nothing derives it any more.
   */
  private settle(
    mention: TranscriptMention,
    candidates: TranscriptMatchCandidate[],
    mappings: RememberedMapping[],
    at: string,
  ): void {
    const current = this.store.latestDecision(mention.id);
    if (current !== null && !isDerivedIdentityDecision(current)) {
      this.repairOwnerDecision(current, at);
      return;
    }
    const derived = this.derive(mention, candidates, mappings, at);
    if (derived === null) {
      if (current === null || current.outcome !== "linked") return;
      this.append({
        ...current,
        action: "unresolved",
        outcome: "unresolved",
        profileId: null,
        profileRevision: null,
        decidedAt: at,
        note:
          current.mappingAuthority === null
            ? "Auto-link withdrawn: no non-conflicting exact stable identifier matches an existing Profile any more."
            : `Withdrawn: remembered mapping lineage ${current.mappingAuthority.lineageId} no longer applies inside its scope.`,
      });
      return;
    }
    if (current !== null && sameOutcome(current, derived)) return;
    this.append(derived);
  }

  /**
   * Auto-link policy: only a non-conflicting exact stable identifier may
   * produce a policy-made "confirmed" link, and only to an existing Profile.
   * Failing that, a remembered mapping applies as standing owner authority —
   * never as stable identity evidence, so it never reaches "confirmed".
   * Nothing here creates a Profile.
   */
  private derive(
    mention: TranscriptMention,
    candidates: TranscriptMatchCandidate[],
    mappings: RememberedMapping[],
    at: string,
  ): IdentityDecision | null {
    const transcriptId = mention.provenance.transcriptId;
    const own = candidates
      .filter((candidate) => candidate.mentionId === mention.id)
      .sort((left, right) => right.score - left.score);
    const top = own[0];
    /* One candidate needs no lead; several need a strict one, so a tie never
       auto-links. */
    const decisive = own.length === 1 || (top?.leadOverNext ?? 0) > 0;
    if (top && top.policyClass === "confirmed" && decisive) {
      return {
        id: this.decisionId(mention.id, `auto|${top.profileId}`),
        mentionId: mention.id,
        transcriptId,
        action: "confirm",
        outcome: "linked",
        profileId: top.profileId,
        profileRevision: this.people.get(top.profileId)?.revision ?? null,
        decidedBy: "policy",
        decidedAt: at,
        note: "Auto-linked on a non-conflicting exact stable identifier.",
        mappingAuthority: null,
      };
    }
    const mapping = mappingResolutionFor(
      mappings,
      transcriptId,
      mention.normalizedForms,
    ).applicable;
    if (mapping === null) return null;
    const profile = this.currentProfile(mapping.profileId);
    if (profile === null) return null;
    return {
      id: this.decisionId(mention.id, `mapping|${mapping.id}|${profile.id}`),
      mentionId: mention.id,
      transcriptId,
      action: "remember-mapping",
      outcome: "linked",
      profileId: profile.id,
      profileRevision: profile.revision,
      decidedBy: "owner",
      decidedAt: at,
      note: `Applied remembered mapping ${mapping.id} v${mapping.mappingVersion} (${mapping.scope} scope).`,
      mappingAuthority: {
        lineageId: mapping.lineageId,
        mappingId: mapping.id,
        mappingVersion: mapping.mappingVersion,
      },
    };
  }

  /**
   * An owner's review decision keeps its authority across identity repair
   * (ticket #121): it follows a merge to the survivor and re-pins a revision
   * whose facts were invalidated, and becomes unresolved only when the Profile
   * it named is gone entirely.
   */
  private repairOwnerDecision(current: IdentityDecision, at: string): void {
    if (current.profileId === null) return;
    const state =
      current.profileRevision === null
        ? null
        : this.people.consumerState(current.profileId, current.profileRevision);
    if (state === null) {
      if (this.currentProfile(current.profileId) !== null) return;
      this.append({
        ...current,
        id: this.decisionId(current.mentionId, `repair|missing|${current.profileId}`),
        action: "unresolved",
        outcome: "unresolved",
        profileId: null,
        profileRevision: null,
        decidedAt: at,
        note: `Unresolved: Profile ${current.profileId} no longer exists.`,
      });
      return;
    }
    if (!state.refreshRequired) return;
    this.append({
      ...current,
      id: this.decisionId(
        current.mentionId,
        `repair|${state.currentProfileId}|${state.currentProfileRevision}`,
      ),
      profileId: state.currentProfileId,
      profileRevision: state.currentProfileRevision,
      decidedAt: at,
      note:
        state.currentProfileId === current.profileId
          ? `Re-pinned to revision ${state.currentProfileRevision} after identity repair invalidated revision ${current.profileRevision}.`
          : `Followed the merge of Profile ${current.profileId} into ${state.currentProfileId}.`,
    });
  }

  /** The Profile that owns this identity today, following merges away. */
  private currentProfile(profileId: string): PersonProfile | null {
    const seen = new Set<string>();
    let record = this.people.get(profileId);
    while (record !== null && record.mergedInto !== undefined && !seen.has(record.id)) {
      seen.add(record.id);
      record = this.people.get(record.mergedInto);
    }
    return record;
  }

  private append(decision: IdentityDecision): void {
    this.store.appendDecision(decision);
  }

  /** Unique per appended record: the audit log keeps every superseded step. */
  private decisionId(mentionId: string, discriminator: string): string {
    const sequence = this.store.readDecisions().filter((d) => d.mentionId === mentionId).length + 1;
    return `id_${createHash("sha1").update(`${mentionId}|${discriminator}|${sequence}`).digest("hex").slice(0, 12)}`;
  }

  /** The shared Person Profiles Review queue: everything weaker than an
   *  auto-link stays here, reviewable, with its full explanation. */
  reviewQueue(): TranscriptReviewQueue {
    const meta = this.store.readTranscriptMeta();
    const mentions = this.store.readMentions();
    const candidates = this.store.readCandidates();
    const organizations = this.store.readOrganizations();
    const mappings = this.store.readMappings();
    return {
      items: mentions
        .filter((mention) => mention.kind === "person" || mention.kind === "ambiguous-name")
        .map((mention) => ({
          transcriptId: mention.provenance.transcriptId,
          transcriptFileName: meta[mention.provenance.transcriptId]?.fileName ?? null,
          meetingDate: meta[mention.provenance.transcriptId]?.meetingDate ?? null,
          mention,
          // Highest-scoring explanation first; presentation order only.
          candidates: candidates
            .filter((candidate) => candidate.mentionId === mention.id)
            .sort(
              (left, right) =>
                right.score - left.score ||
                (right.leadOverNext ?? Number.NEGATIVE_INFINITY) -
                  (left.leadOverNext ?? Number.NEGATIVE_INFINITY) ||
                left.profileId.localeCompare(right.profileId),
            ),
          decision: this.store.latestDecision(mention.id),
          rememberedMapping: mappingResolutionFor(
            mappings,
            mention.provenance.transcriptId,
            mention.normalizedForms,
          ).applicable,
        })),
      organizations: organizations.map((organization) => ({
        transcriptId: organization.provenance.transcriptId,
        transcriptFileName: meta[organization.provenance.transcriptId]?.fileName ?? null,
        organization,
        relatedPeople: mentions
          .filter((mention) => organization.relatedMentionIds.includes(mention.id))
          .map((mention) => ({ mentionId: mention.id, surfaceText: mention.surfaceText })),
        mergeDecision: this.store.latestOrganizationDecision(organization.id),
      })),
    };
  }

  /**
   * Every Confirmed Identity Decision naming this Person Profile, one entry
   * per Transcript Mention, ordered by Transcript then mention.
   *
   * This is the question five call sites used to reassemble for themselves —
   * walk the mentions, resolve each one's latest decision, compare the
   * outcome against a literal. The walk lives here now, with the vocabulary
   * that decides it: the same `settle` that writes an outcome is what reads
   * it back. The order is part of the answer, so a caller deriving a revision
   * string from it gets one that is stable by construction rather than by a
   * sort it remembered to apply.
   */
  confirmedMentions(profileId: string): ConfirmedMention[] {
    const latest = this.latestDecisions();
    return this.store
      .readMentions()
      .flatMap((mention) => {
        const decision = latest.get(mention.id);
        if (decision === undefined || decision.profileId !== profileId) return [];
        return CONFIRMED_OUTCOMES.has(decision.outcome)
          ? [
              {
                transcriptId: mention.provenance.transcriptId,
                mentionId: mention.id,
                quote: mention.provenance.quote,
              },
            ]
          : [];
      })
      .sort(
        (left, right) =>
          left.transcriptId.localeCompare(right.transcriptId) ||
          left.mentionId.localeCompare(right.mentionId),
      );
  }

  /**
   * Everything mined from one Transcript. The Meeting Debrief's runtimes each
   * assembled this from three filtered store reads; it is one question about
   * one Transcript, so it is one method.
   */
  reviewFor(transcriptId: string): TranscriptIdentityReview {
    return {
      mentions: this.store
        .readMentions()
        .filter((mention) => mention.provenance.transcriptId === transcriptId),
      decisions: this.store
        .readDecisions()
        .filter((decision) => decision.transcriptId === transcriptId),
      organizations: this.store
        .readOrganizations()
        .filter((organization) => organization.provenance.transcriptId === transcriptId),
    };
  }

  /**
   * The current decision for every mention, from one read of the append-only
   * record. `latestDecision` answers for one mention and re-reads the whole
   * file to do it; a query that spans mentions reads once and indexes.
   */
  private latestDecisions(): Map<string, IdentityDecision> {
    const latest = new Map<string, IdentityDecision>();
    /* Append order is decision order: the last entry for a mention is the
       one that stands, exactly as `latestDecision` resolves it. */
    for (const decision of this.store.readDecisions()) latest.set(decision.mentionId, decision);
    return latest;
  }

  /**
   * One owner decision from the Review queue. Explicit only: this is the
   * single path through which review work becomes identity, including the
   * one that creates a Profile (the owner's explicit act, never mining's).
   * A decision fans out to the mention named and to undecided mentions of
   * the same form in the same transcript, each recorded as its own audit
   * entry.
   */
  decide(input: DecideInput): IdentityDecision {
    const mention = this.store.readMentions().find((m) => m.id === input.mentionId);
    if (!mention) throw new UnknownMentionError(input.mentionId);
    const transcriptId = mention.provenance.transcriptId;
    const decidedAt = this.now().toISOString();

    let outcome: IdentityDecision["outcome"];
    let profileId: string | null = null;
    switch (input.action) {
      case "confirm": {
        const candidate = input.profileId
          ? this.store
              .readCandidates()
              .find((c) => c.mentionId === mention.id && c.profileId === input.profileId)
          : this.topCandidate(mention.id);
        if (!candidate) {
          throw new InvalidDecisionError("Confirm requires an existing Profile candidate.");
        }
        profileId = candidate.profileId;
        outcome = "linked";
        break;
      }
      case "alternate-profile":
      case "remember-mapping": {
        if (!input.profileId) {
          throw new InvalidDecisionError(`${input.action} requires a Profile id.`);
        }
        if (!this.people.get(input.profileId)) {
          throw new InvalidDecisionError(`Unknown Profile: ${input.profileId}`);
        }
        profileId = input.profileId;
        outcome = "linked";
        break;
      }
      case "create-profile": {
        const observedEmail = mention.emails[0];
        const fullName =
          input.fullName ?? (observedEmail === undefined ? mention.surfaceText : undefined);
        const primaryEmail = input.primaryEmail ?? observedEmail;
        const created = this.people.create({
          ...(fullName === undefined ? {} : { fullName }),
          ...(primaryEmail === undefined ? {} : { primaryEmail }),
        });
        profileId = created.id;
        outcome = "created";
        break;
      }
      case "not-a-person":
        outcome = "not-a-person";
        break;
      case "unresolved":
        outcome = "unresolved";
        break;
    }
    const profileRevision =
      profileId === null ? null : (this.people.get(profileId)?.revision ?? null);

    let mappingForDecision: RememberedMapping | null = null;
    if (input.action === "remember-mapping" && profileId !== null) {
      const scope = input.scope ?? "transcript";
      const scopeId = scope === "transcript" ? transcriptId : null;
      const normalizedForm = mention.normalizedForms[0] ?? normalizeName(mention.surfaceText);
      const lineageId = `rml_${createHash("sha1")
        .update(`${scope}|${scopeId ?? ""}|${normalizedForm}`)
        .digest("hex")
        .slice(0, 12)}`;
      const prior = this.store
        .readMappings()
        .filter((mapping) => mapping.lineageId === lineageId)
        .sort((left, right) => right.mappingVersion - left.mappingVersion)[0];
      const mappingVersion = (prior?.mappingVersion ?? 0) + 1;
      mappingForDecision = {
        id: `${lineageId}_v${mappingVersion}`,
        lineageId,
        supersedesMappingId: prior?.id ?? null,
        scope,
        scopeId,
        normalizedForm,
        surfaceText: mention.surfaceText,
        profileId,
        mappingVersion,
        createdAt: decidedAt,
        revokedAt: null,
      };
      this.store.appendMapping(mappingForDecision);
    }

    /* The named mention is decided here; a new mapping or a newly created
       Profile changes what every other mention matches, so the rematch below
       carries the decision to the rest of its declared scope. */
    const decision: IdentityDecision = {
      id: this.decisionId(mention.id, `${input.action}|${profileId ?? ""}`),
      mentionId: mention.id,
      transcriptId,
      action: input.action,
      outcome,
      profileId,
      profileRevision,
      decidedBy: "owner",
      decidedAt,
      note: input.note ?? null,
      mappingAuthority:
        mappingForDecision === null
          ? null
          : {
              lineageId: mappingForDecision.lineageId,
              mappingId: mappingForDecision.id,
              mappingVersion: mappingForDecision.mappingVersion,
            },
    };
    this.append(decision);
    if (input.action === "create-profile" || input.action === "remember-mapping") this.rematch();
    return this.store.latestDecision(mention.id) ?? decision;
  }

  mappings(): RememberedMapping[] {
    return this.store.readMappings();
  }

  mergeOrganizations(input: MergeOrganizationsInput): OrganizationMergeDecision {
    const organizations = this.store.readOrganizations();
    const source = organizations.find(
      (organization) => organization.id === input.sourceOrganizationMentionId,
    );
    const target = organizations.find(
      (organization) => organization.id === input.targetOrganizationMentionId,
    );
    if (!source || !target) {
      throw new InvalidDecisionError("Organization merge requires two existing Mentions.");
    }
    if (source.id === target.id) {
      throw new InvalidDecisionError("An Organization Mention cannot be merged into itself.");
    }
    const decisionVersion =
      this.store
        .readOrganizationDecisions()
        .filter((decision) => decision.sourceOrganizationMentionId === source.id).length + 1;
    const decidedAt = this.now().toISOString();
    const decision: OrganizationMergeDecision = {
      id: `od_${createHash("sha1").update(`${source.id}|${target.id}|${decisionVersion}`).digest("hex").slice(0, 12)}`,
      action: "merge",
      sourceOrganizationMentionId: source.id,
      targetOrganizationMentionId: target.id,
      decisionVersion,
      algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
      decidedBy: "owner",
      decidedAt,
      note: input.note ?? null,
      provenance: {
        source: source.provenance,
        target: target.provenance,
      },
    };
    this.store.appendOrganizationDecision(decision);
    return decision;
  }

  organizationDecisions(): OrganizationMergeDecision[] {
    return this.store.readOrganizationDecisions();
  }

  /** Reversible by design: revocation ends the lineage's authority and every
   * link derived from it is settled again inside its declared scope. */
  revokeMapping(mappingId: string): RememberedMapping {
    const mapping = this.store.readMappings().find((m) => m.id === mappingId);
    if (!mapping) throw new InvalidDecisionError(`Unknown remembered mapping: ${mappingId}`);
    const latest = this.store
      .readMappings()
      .filter((candidate) => candidate.lineageId === mapping.lineageId)
      .sort((left, right) => right.mappingVersion - left.mappingVersion)[0]!;
    if (latest.revokedAt !== null) return latest;
    const revokedAt = this.now().toISOString();
    const revoked: RememberedMapping = {
      ...latest,
      id: `${latest.lineageId}_v${latest.mappingVersion + 1}`,
      supersedesMappingId: latest.id,
      mappingVersion: latest.mappingVersion + 1,
      createdAt: revokedAt,
      revokedAt,
    };
    this.store.appendMapping(revoked);
    /* Rematching honours the revocation everywhere the lineage reached: a
       link it alone supported becomes unresolved, and a mention still covered
       by a broader active mapping falls back to that authority rather than
       losing its link to a counter comparison. */
    this.rematch();
    return revoked;
  }

  private topCandidate(mentionId: string): TranscriptMatchCandidate | null {
    const own = this.store
      .readCandidates()
      .filter((candidate) => candidate.mentionId === mentionId)
      .sort((left, right) => right.score - left.score);
    return own.find((candidate) => !candidate.conflicts.some((conflict) => conflict.hard)) ?? null;
  }
}

/** Two decisions state the same thing about a mention. */
function sameOutcome(left: IdentityDecision, right: IdentityDecision): boolean {
  return (
    left.action === right.action &&
    left.outcome === right.outcome &&
    left.profileId === right.profileId &&
    left.profileRevision === right.profileRevision &&
    (left.mappingAuthority?.mappingId ?? null) === (right.mappingAuthority?.mappingId ?? null)
  );
}
