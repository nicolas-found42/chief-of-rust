import type { PersonDossierStore } from "./dossier-store.js";
import { parsePersonIdentifier } from "./identifier.js";
import { identifier } from "./resolver.js";
import { socialUrl } from "./sources.js";
import type { PersonProfileStore } from "./store.js";
import {
  PERSON_PROFILE_CALENDAR_SOURCE,
  PERSON_PROFILE_MEETING_PROJECTION_VERSION,
  PERSON_PROFILE_PUBLIC_SAFE_PROJECTION_VERSION,
  PERSON_PROFILE_PRIVACY_DELETE_CONFIRMATION,
  PERSON_PROFILE_REPAIR_FACT_KEYS,
  invalidationAffectsRevision,
  type PersonProfile,
  type PersonProfileCalendarAttendeeInput,
  type PersonProfileCalendarAttendeeResult,
  type PersonProfileCorrectionInput,
  type PersonProfileConsumerState,
  type PersonProfileCreateInput,
  type PersonProfileDetachInput,
  type PersonProfileInvalidation,
  type PersonProfileMergeInput,
  type PersonProfileLifecycleState,
  type PersonProfileDependentConfiguration,
  type PersonProfileResidualSourceArtifact,
  type PersonProfileDeletionCounts,
  type PersonProfileDeletionReceipt,
  type PersonProfileTombstone,
  type PersonProfileProjection,
  type PersonProjectedEvidence,
} from "@chief-of-staff-demo/shared";

/**
 * The Person Profiles deep interface (spec #117, Deep interfaces item 1): the
 * Workspace-owned operations over the canonical store — search, explicit
 * creation, current/exact-revision retrieval, and purpose-specific
 * projections and identity repair. Matching indexes, revision writes,
 * correction, merge, detach/split, and consumer invalidation stay behind it;
 * archive/privacy deletion and the Review queue are separate slices.
 */
export interface PersonProfileSearchOptions {
  /** Case-insensitive text over name, contact, employer, and site identity. */
  query?: string;
  /** Archived Profiles are lifecycle state, not gone; searching them is explicit. */
  includeArchived?: boolean;
}

export class PersonProfileValidationError extends Error {
  constructor(
    public readonly code:
      | "missing-identity-input"
      | "invalid-identity-input"
      | "duplicate-profile"
      | "conflicting-identity"
      | "self-merge"
      | "profile-not-found"
      | "nothing-to-correct"
      | "profile-merged"
      | "merge-conflict"
      | "evidence-not-found"
      | "active-dependencies"
      | "privacy-confirmation-required",
    message: string,
    /* A refused lifecycle operation carries the preview it refused with, so
       the route answers with the disclosure without recomputing it. */
    public readonly lifecycle?: PersonProfileLifecycleState,
  ) {
    super(message);
    this.name = "PersonProfileValidationError";
  }
}

/** The share of a deletion receipt one consumer registry can account for. */
export type PersonProfileRegistryDeletionCounts = Pick<
  PersonProfileDeletionCounts,
  "aliases" | "candidates" | "mappings" | "decisions" | "activeLinks" | "personSnapshots"
>;

/** What one registry discloses about a Profile, derived only from local stores. */
export interface PersonProfileLifecycleInspection {
  dependentConfigurations: PersonProfileDependentConfiguration[];
  residualSourceArtifacts: PersonProfileResidualSourceArtifact[];
}

/**
 * One local Workspace holder of Profile references outside the canonical store.
 * Meeting Brief Runs and the confirmed owner reference each register one; no
 * external provider belongs behind this port.
 */
export interface PersonProfileLifecycleRegistry {
  inspect(profile: PersonProfile): PersonProfileLifecycleInspection;
  privacyDelete(profileId: string): PersonProfileRegistryDeletionCounts;
}

export interface PersonProfileProjectionOptions {
  /** Pin the projection to an exact historical revision; omit for the current one. */
  revision?: number;
}

/**
 * Whether this exact email on this Profile is a verified address (spec #117
 * approval policy, issue #140): the Profile holds the email and carries the
 * completed Calendar attendee provenance that anchors it. Only Calendar may
 * anchor stable emails in this Workspace, so a Profile email without that
 * provenance is an identity signal, never a verified address a Debrief
 * attendee draft could be addressed to.
 */
export function isCalendarVerifiedEmail(profile: PersonProfile, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return (
    profile.emails.some((value) => value.trim().toLowerCase() === normalized) &&
    profile.sourceDiagnostics.some(
      (entry) => entry.source === PERSON_PROFILE_CALENDAR_SOURCE && entry.status === "completed",
    )
  );
}

/** The one email-shape rule; consumers validate addresses against it. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function projected(item: PersonProfile["evidence"][number]): PersonProjectedEvidence {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    url: item.url,
    ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
    matchConfidence: item.matchConfidence,
    observedAt: item.observedAt,
  };
}

function searchHaystack(profile: PersonProfile): string {
  return [
    profile.fullName ?? "",
    ...profile.emails,
    ...Object.values(profile.handles).flat(),
    ...profile.profileUrls,
    profile.role ?? "",
    profile.currentEmployer ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

export class WorkspacePersonProfiles {
  private readonly store: PersonProfileStore;
  private readonly now: () => Date;
  private readonly registries: PersonProfileLifecycleRegistry[];
  private readonly dossiers: PersonDossierStore | undefined;

  constructor(deps: {
    store: PersonProfileStore;
    dossiers?: PersonDossierStore;
    now?: () => Date;
    /* Stated at every composition site, never defaulted: a deletion receipt
       that reports zero references because nobody was asked would certify a
       purge that never happened. An empty list is the explicit claim that
       this Workspace holds Profile references nowhere else. */
    lifecycle: PersonProfileLifecycleRegistry[];
  }) {
    this.dossiers = deps.dossiers;
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.registries = deps.lifecycle;
  }

  search(options: PersonProfileSearchOptions = {}): PersonProfile[] {
    const needle = options.query?.trim().toLowerCase() ?? "";
    return this.store
      .list()
      .filter((profile) => options.includeArchived || profile.archivedAt === null)
      .filter((profile) => !needle || searchHaystack(profile).includes(needle))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** Archive is reversible lifecycle state and never rewrites factual history. */
  archive(profileId: string): PersonProfile {
    const profile = this.repairable(profileId);
    if (profile.archivedAt !== null) return profile;
    const preview = this.lifecycleOf(profile);
    this.requireNoActiveDependencies("archiving", preview);
    const archived = { ...profile, archivedAt: this.now().toISOString() };
    this.store.saveCurrent(archived);
    return archived;
  }

  /** Restore makes the same canonical identity eligible for new consumers. */
  restore(profileId: string): PersonProfile {
    const profile = this.repairable(profileId);
    if (profile.archivedAt === null) return profile;
    const restored = { ...profile, archivedAt: null };
    this.store.saveCurrent(restored);
    return restored;
  }

  /** One local-only preview shared by archive and privacy-delete surfaces. */
  lifecycle(profileId: string): PersonProfileLifecycleState {
    const profile = this.store.get(profileId);
    if (!profile)
      throw new PersonProfileValidationError(
        "profile-not-found",
        "No Person Profile with that id.",
      );
    return this.lifecycleOf(profile);
  }

  /** The preview for one already-loaded Profile record: one registry walk. */
  private lifecycleOf(profile: PersonProfile): PersonProfileLifecycleState {
    const inspected = this.registries.map((registry) => registry.inspect(profile));
    return {
      profileId: profile.id,
      profileRevision: profile.revision,
      archivedAt: profile.archivedAt,
      dependentConfigurations: inspected.flatMap((one) => one.dependentConfigurations),
      residualSourceArtifacts: inspected.flatMap((one) => one.residualSourceArtifacts),
    };
  }

  /**
   * The explicit privacy exception to immutable local history. Every registered
   * local registry is asked to purge its share, and the receipt accounts for
   * all of them; source text and remote providers are outside the operation by
   * construction.
   */
  privacyDelete(profileId: string, input: { confirmation: string }): PersonProfileDeletionReceipt {
    if (input.confirmation !== PERSON_PROFILE_PRIVACY_DELETE_CONFIRMATION)
      throw new PersonProfileValidationError(
        "privacy-confirmation-required",
        `Privacy deletion requires the exact confirmation ${PERSON_PROFILE_PRIVACY_DELETE_CONFIRMATION}.`,
      );
    const profile = this.store.get(profileId);
    if (!profile)
      throw new PersonProfileValidationError(
        "profile-not-found",
        "No Person Profile with that id.",
      );
    /* One preview serves the refusal (an active dependent configuration),
       the receipt's residual disclosure, and the confirmation surface. */
    const preview = this.lifecycleOf(profile);
    this.requireNoActiveDependencies("privacy-deleting", preview);
    const registryRemoved = this.purgeRegistries(profileId);
    const deletedAt = this.now().toISOString();
    const canonicalRemoved = this.store.privacyDelete(profile, deletedAt);
    const receipt: PersonProfileDeletionReceipt = {
      receiptId: `profile-deletion-${profileId}-${deletedAt}`,
      profileId,
      deletedAt,
      removed: {
        canonicalProfileRecords: canonicalRemoved.canonicalProfileRecords,
        revisions: canonicalRemoved.revisions,
        evidence: canonicalRemoved.evidence,
        ...registryRemoved,
      },
      tombstone: canonicalRemoved.tombstone,
      residualSourceArtifacts: preview.residualSourceArtifacts,
      remoteProviderOperations: 0,
    };
    this.store.saveDeletionReceipt(receipt);
    return receipt;
  }

  tombstone(profileId: string): PersonProfileTombstone | null {
    return this.store.getTombstone(profileId);
  }

  deletionReceipt(profileId: string): PersonProfileDeletionReceipt | null {
    return this.store.getDeletionReceipt(profileId);
  }

  acceptResearchFacts(
    profileId: string,
    expectedRevision: number,
    facts: {
      field: "fullName" | "role" | "currentEmployer" | "background";
      value: string;
      sourceIds: string[];
      effectiveFrom: string | null;
      authority: "self-report" | "independent-account" | "primary-artifact";
      reason: string;
    }[],
  ): PersonProfile | null {
    const current = this.store.get(profileId);
    if (
      !current ||
      current.archivedAt ||
      current.mergedInto ||
      current.revision !== expectedRevision
    )
      return current;
    const next = { ...current };
    const reasons: string[] = [];
    for (const fact of facts) {
      if (!fact.sourceIds.length || !fact.value.trim() || next[fact.field] === fact.value) continue;
      if (
        facts.some(
          (other) =>
            other.field === fact.field &&
            other.value !== fact.value &&
            other.effectiveFrom === fact.effectiveFrom,
        )
      )
        continue;
      const effective = fact.effectiveFrom === null ? null : Date.parse(fact.effectiveFrom);
      if (effective !== null && (!Number.isFinite(effective) || effective > this.now().getTime()))
        continue;
      /* Anti-recency protection is the authority, effective-date and reason
         triple — never comparison with the correction's audit timestamp: a
         primary artifact dated before the correction can establish that the
         correction was already wrong when it was recorded (#204). */
      if (
        next[fact.field] !== null &&
        (fact.authority !== "primary-artifact" || effective === null || !fact.reason.trim())
      )
        continue;
      next[fact.field] = fact.value;
      next.researchFacts = {
        ...next.researchFacts,
        [fact.field]: {
          value: fact.value,
          sourceIds: fact.sourceIds,
          effectiveFrom: fact.effectiveFrom,
        },
      };
      reasons.push(
        `${fact.field}: ${fact.reason || "Matched source supplies the previously unknown fact."} Sources: ${fact.sourceIds.join(", ")}. Effective: ${fact.effectiveFrom ?? "undated"}.`,
      );
    }
    if (!reasons.length) return current;
    return this.appendRevision(next, {
      kind: "correction",
      affectedRevision: current.revision,
      detail: `Automatic research update. ${reasons.join(" ")}`,
    });
  }

  forgetResearchSource(profileId: string, sourceId: string): PersonProfile | null {
    const current = this.store.get(profileId);
    if (!current) return null;
    const next = { ...current, researchFacts: { ...current.researchFacts } };
    let changed = false;
    for (const field of ["fullName", "role", "currentEmployer", "background"] as const) {
      const lineage = next.researchFacts[field];
      if (!lineage?.sourceIds.includes(sourceId)) continue;
      if (next[field] === lineage.value) next[field] = null;
      delete next.researchFacts[field];
      changed = true;
    }
    return changed
      ? this.appendRevision(next, {
          kind: "evidence-detached",
          affectedRevision: current.revision,
          evidenceId: sourceId,
          detail: "Removed automatic facts that depended on a rejected source attribution.",
        })
      : current;
  }

  ensureIdentifier(value: string): PersonProfile {
    const signals = parsePersonIdentifier(value);
    const holders = this.store
      .list()
      .filter(
        (profile) =>
          profile.emails.some((email) => signals.emails.includes(email)) ||
          profile.profileUrls.some((url) => signals.profileUrls.includes(url)),
      );
    const canonical = holders.filter((profile) => !profile.mergedInto);
    if (canonical.length > 1)
      throw new PersonProfileValidationError(
        "conflicting-identity",
        "Several Profiles hold that identity.",
      );
    if (canonical[0]) {
      if (canonical[0].archivedAt)
        throw new PersonProfileValidationError(
          "conflicting-identity",
          "Restore the archived Profile before reusing it.",
        );
      return canonical[0];
    }
    if (this.store.getTombstone(identifier(signals)))
      throw new PersonProfileValidationError(
        "conflicting-identity",
        "This identity was privacy-deleted.",
      );
    return this.create({
      ...(signals.emails[0] ? { primaryEmail: signals.emails[0] } : {}),
      profileUrls: signals.profileUrls,
    });
  }

  create(input: PersonProfileCreateInput): PersonProfile {
    const profileUrls = [
      ...new Set(
        (input.profileUrls ?? []).flatMap((url) => parsePersonIdentifier(url).profileUrls),
      ),
    ];
    const fullName = trimmed(input.fullName);
    const primaryEmail = trimmed(input.primaryEmail)?.toLowerCase() ?? null;
    if (!fullName && !primaryEmail && profileUrls.length === 0)
      throw new PersonProfileValidationError(
        "missing-identity-input",
        "A Person Profile needs at least a full name, an email address, or a profile URL.",
      );
    if (primaryEmail && !EMAIL_PATTERN.test(primaryEmail))
      throw new PersonProfileValidationError(
        "invalid-identity-input",
        `Not an email address: ${primaryEmail}`,
      );
    /* An exact email is a stable identifier, so it refuses creation as a
       duplicate; a name alone is review material (spec #117), so a same-named
       Profile is not a collision and gets its own disambiguated id below. */
    if (primaryEmail) {
      const byEmail = this.store.findBySignals({
        emails: [primaryEmail],
        fullNames: [],
        handles: {},
        profileUrls: [],
        employerHints: [],
      });
      if (byEmail && byEmail.emails.includes(primaryEmail))
        throw new PersonProfileValidationError(
          "duplicate-profile",
          "A Person Profile with this identity already exists.",
        );
    }

    const observedAt = this.now().toISOString();
    const candidate: PersonProfile = {
      id: this.uniqueId(
        identifier({
          emails: primaryEmail ? [primaryEmail] : [],
          fullNames: fullName ? [fullName] : [],
          handles: {},
          profileUrls,
          employerHints: [],
        }),
      ),
      revision: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
      fullName,
      primaryEmail,
      emails: primaryEmail ? [primaryEmail] : [],
      handles: {},
      profileUrls,
      employerHints: [],
      role: trimmed(input.role),
      background: trimmed(input.background),
      currentEmployer: trimmed(input.currentEmployer),
      socialProfiles: [],
      websites: [],
      feeds: [],
      publications: [],
      mentions: [],
      evidence: [],
      sourceDiagnostics: [],
      archivedAt: null,
    };
    if (this.store.getTombstone(candidate.id))
      throw new PersonProfileValidationError(
        "conflicting-identity",
        "This identity was privacy-deleted.",
      );
    this.store.save(candidate);
    return candidate;
  }

  /**
   * Identity repair (ticket #121): an ordinary factual correction appends a
   * new revision. The superseded snapshot stays exactly readable, and the
   * correction files an invalidation so consumers of the old revision refresh.
   */
  correct(profileId: string, input: PersonProfileCorrectionInput): PersonProfile {
    const current = this.repairable(profileId);
    const next: PersonProfile = { ...current };

    let stated = 0;
    const fullName = trimmed(input.fullName);
    if (fullName !== null) {
      stated += 1;
      next.fullName = fullName;
    }
    for (const field of ["role", "currentEmployer", "background"] as const) {
      const value = input[field];
      if (value === undefined) continue;
      stated += 1;
      next[field] = value === null ? null : trimmed(value);
    }

    if (input.primaryEmail !== undefined) {
      const primaryEmail =
        input.primaryEmail === null ? null : (trimmed(input.primaryEmail)?.toLowerCase() ?? null);
      /* A blank form field still means "not stated"; JSON null is the explicit
         repair decision that clears a false canonical address. */
      if (input.primaryEmail === null || primaryEmail !== null) {
        stated += 1;
        if (primaryEmail !== null && !EMAIL_PATTERN.test(primaryEmail))
          throw new PersonProfileValidationError(
            "invalid-identity-input",
            `Not an email address: ${primaryEmail}`,
          );
        if (primaryEmail !== null && primaryEmail !== current.primaryEmail)
          this.ensureEmailAvailable(primaryEmail, [current.id]);
        next.primaryEmail = primaryEmail;
        /* A corrected-away primary address is no longer a current identity
           signal. Its exact value remains readable only on old revisions. */
        next.emails = next.emails.filter((email) => email !== current.primaryEmail);
        if (primaryEmail !== null && !next.emails.includes(primaryEmail))
          next.emails = [...next.emails, primaryEmail];
      }
    }

    if (input.profileUrls !== undefined) {
      stated += 1;
      /* Identity Signals, not facts: a name-only Profile can never match public
         evidence above "medium", and every projected field (role, employer,
         social profiles) is drawn from "high" matches only. Correcting the URLs
         is how the operator lifts a Profile out of that floor. */
      const urls: string[] = [];
      const handles: Record<string, string[]> = {};
      for (const raw of input.profileUrls ?? []) {
        const value = raw.trim();
        if (!value) continue;
        if (EMAIL_PATTERN.test(value))
          throw new PersonProfileValidationError(
            "invalid-identity-input",
            `Not a profile URL: ${value}. Correct the canonical address with primaryEmail.`,
          );
        /* A bare "linkedin.com/in/someone" is what people paste; the scheme is
           assumed rather than demanded, as it is for a typed identifier. */
        const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
        let url: URL;
        try {
          url = new URL(candidate);
        } catch {
          throw new PersonProfileValidationError(
            "invalid-identity-input",
            `Not a profile URL: ${value}. Enter something like "linkedin.com/in/someone".`,
          );
        }
        const normalized = url.toString();
        if (!urls.includes(normalized)) urls.push(normalized);
        const social = socialUrl(normalized);
        if (social?.kind === "profile" && social.handle) {
          const existing = handles[social.platform] ?? [];
          if (!existing.includes(social.handle)) existing.push(social.handle);
          handles[social.platform] = existing;
        }
      }
      next.profileUrls = urls;
      next.handles = handles;
    }

    if (stated === 0)
      throw new PersonProfileValidationError(
        "nothing-to-correct",
        "A correction states at least one fact to change.",
      );

    return this.appendRevision(next, {
      kind: "correction",
      affectedRevision: current.revision,
      detail:
        input.note?.trim() ||
        `Revision ${current.revision} facts were corrected; treat that revision as superseded.`,
    });
  }

  /**
   * Neither archive nor privacy deletion may quietly strand a consumer that is
   * still pointed at this Profile: the operator resolves each active
   * configuration explicitly, by pausing or re-pointing it, and retries. The
   * thrown error carries the preview it refused with, so the route answers
   * with the disclosure instead of recomputing it.
   */
  private requireNoActiveDependencies(
    operation: string,
    preview: PersonProfileLifecycleState,
  ): void {
    const active = preview.dependentConfigurations.filter(
      (dependency) => dependency.state === "active",
    );
    if (active.length === 0) return;
    throw new PersonProfileValidationError(
      "active-dependencies",
      `Pause or re-point every active dependent configuration before ${operation} this Profile.`,
      preview,
    );
  }

  private purgeRegistries(profileId: string): PersonProfileRegistryDeletionCounts {
    const total: PersonProfileRegistryDeletionCounts = {
      aliases: 0,
      candidates: 0,
      mappings: 0,
      decisions: 0,
      activeLinks: 0,
      personSnapshots: 0,
    };
    for (const registry of this.registries) {
      const removed = registry.privacyDelete(profileId);
      for (const key of Object.keys(total) as (keyof PersonProfileRegistryDeletionCounts)[])
        total[key] += removed[key];
    }
    return total;
  }

  /** The current record of a Profile that still owns its identity. */
  private repairable(profileId: string): PersonProfile {
    const profile = this.store.get(profileId);
    if (!profile)
      throw new PersonProfileValidationError(
        "profile-not-found",
        "No Person Profile with that id.",
      );
    if (profile.mergedInto)
      throw new PersonProfileValidationError(
        "profile-merged",
        `This Profile was merged into ${profile.mergedInto}; follow that id instead.`,
      );
    return profile;
  }

  /** Persists the next revision and marks every prior consumer pin for refresh. */
  private appendRevision(
    next: PersonProfile,
    record: Omit<PersonProfileInvalidation, "id" | "occurredAt">,
  ): PersonProfile {
    const occurredAt = this.now().toISOString();
    const invalidations = next.invalidations ?? [];
    const affectedRevisions = this.store
      .listRevisions(next.id)
      .map((revision) => revision.revision);
    const repaired: PersonProfile = {
      ...next,
      revision: next.revision + 1,
      updatedAt: occurredAt,
      invalidations: [
        ...invalidations,
        {
          id: `inv_${invalidations.length + 1}`,
          ...record,
          affectedRevisions,
          occurredAt,
        },
      ],
    };
    this.store.save(repaired);
    return repaired;
  }

  /** Refuses a primary email another Profile already holds; `selfIds` are exempt. */
  private ensureEmailAvailable(primaryEmail: string, selfIds: string[]): void {
    const holder = this.store.findBySignals({
      emails: [primaryEmail],
      fullNames: [],
      handles: {},
      profileUrls: [],
      employerHints: [],
    });
    if (holder && !selfIds.includes(holder.id) && holder.emails.includes(primaryEmail))
      throw new PersonProfileValidationError(
        "duplicate-profile",
        "Another Person Profile already holds this email address.",
      );
  }

  /**
   * Identity repair (ticket #121): merge a duplicate Profile away into the
   * surviving one through an audited decision. Evidence keeps its original
   * provenance, identity signals union, conflicting facts must be resolved
   * explicitly, and the merged-away Profile stays readable as an audit record
   * that redirects consumers to the survivor.
   */
  merge(survivorId: string, input: PersonProfileMergeInput): PersonProfile {
    const survivor = this.repairable(survivorId);
    if (input.duplicateId === survivorId)
      throw new PersonProfileValidationError(
        "self-merge",
        "A Profile cannot be merged into itself.",
      );
    const duplicate = this.store.get(input.duplicateId);
    if (!duplicate)
      throw new PersonProfileValidationError(
        "profile-not-found",
        "No Person Profile with that id.",
      );
    if (duplicate.mergedInto)
      throw new PersonProfileValidationError(
        "profile-merged",
        `That Profile was already merged into ${duplicate.mergedInto}.`,
      );

    const resolutions = input.resolutions ?? {};
    const conflicts = PERSON_PROFILE_REPAIR_FACT_KEYS.filter(
      (field) =>
        survivor[field] !== null &&
        duplicate[field] !== null &&
        survivor[field] !== duplicate[field],
    );
    const unresolved = conflicts.filter((field) => resolutions[field] === undefined);
    if (unresolved.length > 0)
      throw new PersonProfileValidationError(
        "merge-conflict",
        `Both Profiles state different ${unresolved.join(", ")}; resolve them explicitly.`,
      );
    const resolved = (
      field: Exclude<(typeof PERSON_PROFILE_REPAIR_FACT_KEYS)[number], "primaryEmail">,
    ): string | null => {
      const choice = trimmed(resolutions[field]);
      if (choice !== null) return choice;
      return survivor[field] ?? duplicate[field];
    };
    const primaryEmail =
      trimmed(resolutions.primaryEmail)?.toLowerCase() ??
      survivor.primaryEmail ??
      duplicate.primaryEmail;
    if (primaryEmail !== null && !EMAIL_PATTERN.test(primaryEmail))
      throw new PersonProfileValidationError(
        "invalid-identity-input",
        `Not an email address: ${primaryEmail}`,
      );
    if (primaryEmail !== null) this.ensureEmailAvailable(primaryEmail, [survivor.id, duplicate.id]);

    const union = (left: string[], right: string[]): string[] => [...new Set([...left, ...right])];
    const unionBy = <T>(left: T[], right: T[], key: (item: T) => string): T[] => {
      const seen = new Set<string>();
      const result: T[] = [];
      for (const item of [...left, ...right]) {
        const identity = key(item);
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push(item);
      }
      return result;
    };

    const next: PersonProfile = {
      ...survivor,
      fullName: resolved("fullName"),
      role: resolved("role"),
      currentEmployer: resolved("currentEmployer"),
      background: resolved("background"),
      primaryEmail,
      emails: union(union(survivor.emails, duplicate.emails), primaryEmail ? [primaryEmail] : []),
      handles: Object.fromEntries(
        [...new Set([...Object.keys(survivor.handles), ...Object.keys(duplicate.handles)])].map(
          (platform) => [
            platform,
            union(survivor.handles[platform] ?? [], duplicate.handles[platform] ?? []),
          ],
        ),
      ),
      profileUrls: union(survivor.profileUrls, duplicate.profileUrls),
      employerHints: union(survivor.employerHints, duplicate.employerHints),
      socialProfiles: unionBy(survivor.socialProfiles, duplicate.socialProfiles, (s) => s.url),
      websites: union(survivor.websites, duplicate.websites),
      feeds: unionBy(survivor.feeds, duplicate.feeds, (feed) => feed.url),
      publications: unionBy(survivor.publications, duplicate.publications, (item) => item.id),
      mentions: unionBy(survivor.mentions, duplicate.mentions, (item) => item.id),
      evidence: unionBy(survivor.evidence, duplicate.evidence, (item) => item.id),
    };

    this.dossiers?.merge(survivorId, duplicate.id);
    const merged = this.appendRevision(next, {
      kind: "merge",
      affectedRevision: survivor.revision,
      mergedFrom: duplicate.id,
      detail:
        input.note?.trim() ||
        `Merged ${duplicate.id} into this Profile; its evidence and signals carry their original provenance.`,
    });
    this.appendRevision(
      { ...duplicate, mergedInto: survivor.id },
      {
        kind: "merge",
        affectedRevision: duplicate.revision,
        mergedInto: survivor.id,
        detail:
          input.note?.trim() ||
          `Merged into ${survivor.id}; this Profile remains readable as an audit record.`,
      },
    );
    return merged;
  }

  /**
   * Identity repair (ticket #121): detach one evidence record from the
   * Profile it was attributed to, optionally splitting it onto the correct
   * Profile. The old attribution stays readable in past revisions but is
   * filed as invalid, so it is never presented as current fact.
   */
  detachEvidence(
    profileId: string,
    input: PersonProfileDetachInput,
  ): { from: PersonProfile; to: PersonProfile | null } {
    const source = this.repairable(profileId);
    /* A bad target must refuse the whole decision durably, so the target is
       resolved before anything is written. */
    const target = input.toProfileId === undefined ? null : this.repairable(input.toProfileId);
    if (target && target.id === source.id)
      throw new PersonProfileValidationError(
        "invalid-identity-input",
        "Evidence cannot be detached to the Profile it is already attributed to.",
      );

    const evidenceLocations = ["publications", "mentions", "evidence"] as const;
    const representations = evidenceLocations.flatMap((location) =>
      source[location]
        .filter((item) => item.id === input.evidenceId)
        .map((item) => ({ location, item })),
    );
    if (representations.length === 0)
      throw new PersonProfileValidationError(
        "evidence-not-found",
        "No such evidence record on that Profile.",
      );

    const from = this.appendRevision(
      {
        ...source,
        publications: source.publications.filter((item) => item.id !== input.evidenceId),
        mentions: source.mentions.filter((item) => item.id !== input.evidenceId),
        evidence: source.evidence.filter((item) => item.id !== input.evidenceId),
      },
      {
        kind: "evidence-detached",
        affectedRevision: source.revision,
        evidenceId: input.evidenceId,
        ...(input.toProfileId === undefined ? {} : { movedTo: input.toProfileId }),
        detail:
          input.note?.trim() ||
          `Evidence ${input.evidenceId} is no longer attributed to this Profile.`,
      },
    );

    let to: PersonProfile | null = null;
    if (target !== null) {
      const movedTo = <T extends (typeof evidenceLocations)[number]>(location: T) => [
        ...target[location],
        ...representations
          .filter((representation) => representation.location === location)
          .map((representation) => representation.item)
          .filter((item) => !target[location].some((existing) => existing.id === item.id)),
      ];
      to = this.appendRevision(
        {
          ...target,
          publications: movedTo("publications"),
          mentions: movedTo("mentions"),
          evidence: movedTo("evidence"),
        },
        {
          kind: "evidence-detached",
          affectedRevision: target.revision,
          evidenceId: input.evidenceId,
          movedFrom: source.id,
          detail:
            input.note?.trim() ||
            `Evidence ${input.evidenceId} was re-attributed from ${source.id}.`,
        },
      );
    }
    return { from, to };
  }

  get(profileId: string): PersonProfile | null {
    return this.store.get(profileId);
  }

  getRevision(profileId: string, revision: number): PersonProfile | null {
    return this.store.getRevision(profileId, revision);
  }

  revisions(profileId: string): PersonProfile[] {
    return this.store.listRevisions(profileId);
  }

  project(
    purpose: "public-safe" | "meeting",
    profileId: string,
    options?: PersonProfileProjectionOptions,
  ): PersonProfileProjection | null {
    const profile =
      options?.revision === undefined
        ? this.store.get(profileId)
        : this.store.getRevision(profileId, options.revision);
    const currentRecord = this.store.get(profileId);
    /* A merged-away Profile has no current identity of its own; consumers
       follow mergedInto. Its exact revisions stay projected as history. */
    /* Archive stops new consumption: no purpose-specific projection is served
       for an archived Profile, current or exact-revision. Its revisions stay
       readable as history through the revision interface. */
    if (currentRecord?.archivedAt) return null;
    if (currentRecord?.mergedInto !== undefined && options?.revision === undefined) return null;
    if (!profile) return null;
    /* Immutable history discloses its own invalidation: a projection of an
       older revision carries every repair record filed against it. */
    const affecting = (currentRecord?.invalidations ?? []).filter((record) =>
      invalidationAffectsRevision(record, profile.revision),
    );
    const base = {
      ...(affecting.length === 0 ? {} : { invalidations: affecting }),
      profileId: profile.id,
      profileRevision: profile.revision,
      fullName: profile.fullName,
      role: profile.role,
      background: profile.background,
      currentEmployer: profile.currentEmployer,
      socialProfiles: profile.socialProfiles,
      websites: profile.websites,
      feeds: profile.feeds,
    };
    if (purpose === "public-safe")
      return {
        purpose,
        projectionVersion: PERSON_PROFILE_PUBLIC_SAFE_PROJECTION_VERSION,
        ...base,
        // Publications only: mention and CRM/contact evidence are outside the
        // public-safe authority, along with every email and diagnostic.
        publications: profile.publications.map(projected),
      };
    return {
      purpose,
      projectionVersion: PERSON_PROFILE_MEETING_PROJECTION_VERSION,
      ...base,
      primaryEmail: profile.primaryEmail,
      emails: profile.emails,
      publications: profile.publications.map(projected),
      mentions: profile.mentions.map(projected),
      evidence: profile.evidence.map(projected),
    };
  }

  /** The append-only invalidation log of a Profile; consumers poll it to refresh. */
  invalidations(profileId: string): PersonProfileInvalidation[] {
    return this.store.get(profileId)?.invalidations ?? [];
  }

  /** Derives whether an exact consumer pin needs refresh without editing its artifact. */
  consumerState(profileId: string, profileRevision: number): PersonProfileConsumerState | null {
    const pinned = this.store.getRevision(profileId, profileRevision);
    const record = this.store.get(profileId);
    if (!pinned || !record) return null;
    const invalidations = (record.invalidations ?? []).filter((invalidation) =>
      invalidationAffectsRevision(invalidation, profileRevision),
    );
    const current = record.mergedInto ? this.store.get(record.mergedInto) : record;
    if (!current) return null;
    return {
      profileId,
      profileRevision,
      currentProfileId: current.id,
      currentProfileRevision: current.revision,
      refreshRequired: record.mergedInto !== undefined || invalidations.length > 0,
      invalidations,
    };
  }
  /** Keeps the canonical id stable while letting a name-only second Profile exist. */
  private uniqueId(base: string): string {
    let id = base;
    for (let n = 2; this.store.get(id); n += 1) id = `${base}-${n}`;
    return id;
  }

  /**
   * Calendar attendee identity (issue #124, spec #117 creation and matching
   * policy): the exact Calendar email is an authoritative anchor, so a
   * non-conflicting exact match reuses the existing Profile and an unknown
   * attendee receives one idempotent minimal email-anchored shell with source
   * provenance. Calendar never supplies inferred employer, title, biography,
   * or public-search claims, so nothing else is recorded. Conflicting stable
   * identifiers fail visibly — they are never merged or overwritten here.
   */
  ensureCalendarAttendeeProfile(
    input: PersonProfileCalendarAttendeeInput,
  ): PersonProfileCalendarAttendeeResult {
    const email = trimmed(input.email)?.toLowerCase() ?? null;
    if (!email)
      throw new PersonProfileValidationError(
        "missing-identity-input",
        "A Calendar attendee shell needs the attendee's email address.",
      );
    if (!EMAIL_PATTERN.test(email))
      throw new PersonProfileValidationError(
        "invalid-identity-input",
        `Not an email address: ${email}`,
      );

    /* An exact email is a stable identifier: every Profile holding it is a
       reuse candidate, and more than one holder is a visible conflict, never
       an automatic merge. */
    const holders = this.store
      .list()
      .filter((profile) => profile.emails.some((value) => value.trim().toLowerCase() === email));
    if (holders.length > 1)
      throw new PersonProfileValidationError(
        "conflicting-identity",
        `Two or more Person Profiles already hold the Calendar attendee email ${email}; resolve the duplicate explicitly instead of merging automatically.`,
      );
    if (holders.length === 1) {
      const holder = holders[0]!;
      if (holder.archivedAt !== null)
        throw new PersonProfileValidationError(
          "conflicting-identity",
          `An archived Person Profile holds the Calendar attendee email ${email}; restore or resolve it explicitly before Calendar reuses it.`,
        );
      return { profile: holder, created: false };
    }

    /* The canonical id derives from the email, which keeps the shell stable
       across event revisions and sibling occurrences. If that id already
       belongs to a Profile without this email, the stable identifiers
       conflict — fail visibly rather than overwrite. */
    const id = identifier({
      emails: [email],
      fullNames: [],
      handles: {},
      profileUrls: [],
      employerHints: [],
    });
    if (this.store.getTombstone(id))
      throw new PersonProfileValidationError(
        "conflicting-identity",
        "This Calendar identity was privacy-deleted.",
      );
    const squatter = this.store.get(id);
    if (squatter)
      throw new PersonProfileValidationError(
        "conflicting-identity",
        `The canonical id derived from the Calendar attendee email ${email} already belongs to Person Profile ${squatter.id}; resolve the conflict explicitly instead of overwriting it.`,
      );

    const observedAt = this.now().toISOString();
    const shell: PersonProfile = {
      id,
      revision: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
      fullName: null,
      primaryEmail: email,
      emails: [email],
      handles: {},
      profileUrls: [],
      employerHints: [],
      role: null,
      background: null,
      currentEmployer: null,
      socialProfiles: [],
      websites: [],
      feeds: [],
      publications: [],
      mentions: [],
      evidence: [],
      sourceDiagnostics: [
        {
          source: PERSON_PROFILE_CALENDAR_SOURCE,
          status: "completed",
          detail: input.provenance
            ? `Calendar attendee shell — ${input.provenance}`
            : "Calendar attendee shell",
        },
      ],
      archivedAt: null,
    };
    this.store.save(shell);
    return { profile: shell, created: true };
  }
}
