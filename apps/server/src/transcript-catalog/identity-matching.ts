import type {
  PersonProfile,
  RememberedMapping,
  TranscriptCandidateConflict,
  TranscriptCandidatePolicyClass,
  TranscriptCandidateSignal,
  TranscriptMention,
} from "@chief-of-staff-demo/shared";
import {
  normalizeExternalContactIds,
  normalizeHandles,
  normalizeName,
  normalizeProfileUrl,
  unique,
} from "./identity-extraction.js";

const WEIGHT_EXACT_EMAIL = 5;
const WEIGHT_EXACT_PROFILE_URL = 5;
const WEIGHT_VERIFIED_HANDLE = 5;
const WEIGHT_EXTERNAL_CONTACT_ID = 5;
const WEIGHT_SPEAKER_CALENDAR_EMAIL = 5;
const WEIGHT_REMEMBERED_MAPPING = 5;
const WEIGHT_FULL_NAME = 2;
const WEIGHT_ALIAS = 2;
const WEIGHT_TITLE = 1;
const WEIGHT_ROLE = 1;
const WEIGHT_ROSTER_CONTEXT = 2;
const WEIGHT_SPEAKER_LABEL = 1;
const WEIGHT_EMPLOYER_HINT = 1;
const PROBABLE_MIN_SCORE = WEIGHT_FULL_NAME;
const PROBABLE_MIN_LEAD = 2;

function profileNameForms(profile: PersonProfile): string[] {
  return unique(
    [profile.fullName].filter((value): value is string => value !== null).map(normalizeName),
  );
}

interface StableIdentifier {
  kind: "email" | "profile-url" | "handle" | "external-contact-id";
  key: string;
  display: string;
}

function uniqueStableIdentifiers(items: StableIdentifier[]): StableIdentifier[] {
  return [...new Map(items.map((item) => [item.key, item])).values()];
}

/* Shared per-kind key builders: mention and profile identifiers must derive
   identical keys or exact stable-identifier matching silently breaks. */
function emailIdentifier(email: string, display: string): StableIdentifier {
  return {
    kind: "email",
    key: `email:${email.normalize("NFKC").toLowerCase()}`,
    display,
  };
}

function profileUrlIdentifier(value: string): StableIdentifier | null {
  const url = normalizeProfileUrl(value);
  return url === null ? null : { kind: "profile-url", key: `profile-url:${url}`, display: url };
}

function handleIdentifiers(handles: Record<string, string[]>): StableIdentifier[] {
  return Object.entries(handles).flatMap(([platform, handlesForPlatform]) =>
    handlesForPlatform.map((handle) => ({
      kind: "handle" as const,
      key: `handle:${platform}:${handle}`,
      display: `${platform}:${handle}`,
    })),
  );
}

function externalContactIdentifiers(
  ids: TranscriptMention["externalContactIds"],
): StableIdentifier[] {
  return normalizeExternalContactIds(ids).map((item) => ({
    kind: "external-contact-id" as const,
    key: `external-contact-id:${item.system}:${item.externalId}`,
    display: `${item.system}:${item.externalId}`,
  }));
}

function mentionStableIdentifiers(mention: TranscriptMention): StableIdentifier[] {
  return uniqueStableIdentifiers([
    ...mention.emails.map((email) => emailIdentifier(email, email)),
    ...(mention.speakerCalendarEmail === null
      ? []
      : [emailIdentifier(mention.speakerCalendarEmail, mention.speakerCalendarEmail)]),
    ...mention.profileUrls.flatMap((value) => {
      const identifier = profileUrlIdentifier(value);
      return identifier === null ? [] : [identifier];
    }),
    ...handleIdentifiers(normalizeHandles(mention.verifiedHandles)),
    ...externalContactIdentifiers(mention.externalContactIds),
  ]);
}

function profileStableIdentifiers(profile: PersonProfile): StableIdentifier[] {
  return uniqueStableIdentifiers([
    ...unique([
      ...profile.emails,
      ...(profile.primaryEmail === null ? [] : [profile.primaryEmail]),
    ]).map((email) => emailIdentifier(email, email.normalize("NFC").toLowerCase())),
    ...profile.profileUrls.flatMap((value) => {
      const identifier = profileUrlIdentifier(value);
      return identifier === null ? [] : [identifier];
    }),
    ...handleIdentifiers(normalizeHandles(profile.handles)),
    ...externalContactIdentifiers(profile.externalContactIds ?? []),
  ]);
}

/** Per-pass index of each Profile's stable identifiers: conflictsFor re-derives
   them per candidate, so a rematch pass builds this once and shares it. */
export function profileIdentifiersOf(profiles: PersonProfile[]): Map<string, StableIdentifier[]> {
  return new Map(profiles.map((profile) => [profile.id, profileStableIdentifiers(profile)]));
}

export interface MappingResolution {
  applicable: RememberedMapping | null;
  evidence: RememberedMapping[];
  conflicting: boolean;
}

export function mappingResolutionFor(
  mappings: RememberedMapping[],
  transcriptId: string,
  forms: string[],
): MappingResolution {
  const normalizedForms = new Set(forms.map(normalizeName));
  const latestByLineage = new Map<string, RememberedMapping>();
  for (const mapping of mappings) {
    if (!normalizedForms.has(normalizeName(mapping.normalizedForm))) continue;
    if (mapping.scope === "transcript" && mapping.scopeId !== transcriptId) continue;
    const current = latestByLineage.get(mapping.lineageId);
    if (current === undefined || mapping.mappingVersion > current.mappingVersion) {
      latestByLineage.set(mapping.lineageId, mapping);
    }
  }
  const active = [...latestByLineage.values()].filter((mapping) => mapping.revokedAt === null);
  const transcriptAuthorities = active.filter((mapping) => mapping.scope === "transcript");
  const evidence =
    transcriptAuthorities.length > 0
      ? transcriptAuthorities
      : active.filter((mapping) => mapping.scope === "workspace");
  const conflicting = new Set(evidence.map((mapping) => mapping.profileId)).size > 1;
  const applicable = conflicting
    ? null
    : ([...evidence].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
      )[0] ?? null);
  return { applicable, evidence, conflicting };
}

export function candidateSignals(
  mention: TranscriptMention,
  profile: PersonProfile,
  mapping: MappingResolution,
): TranscriptCandidateSignal[] {
  const profileForms = profileNameForms(profile);
  const mentionName = mention.normalizedForms[0] ?? "";
  const profileName = profile.fullName === null ? null : normalizeName(profile.fullName);
  const aliasMatched =
    profileName !== null && mention.aliases.map(normalizeName).includes(profileName);
  const nameMatched =
    profileName !== null &&
    (mention.normalizedForms.includes(profileName) ||
      (mentionName.split(" ").length === 1 &&
        profileForms.some((form) => {
          const tokens = form.split(" ");
          return tokens[0] === mentionName || tokens[tokens.length - 1] === mentionName;
        })));
  const profileEmails = unique(
    [...profile.emails, ...(profile.primaryEmail === null ? [] : [profile.primaryEmail])].map(
      (email) => email.normalize("NFKC").toLowerCase(),
    ),
  );
  const emailMatched = profileEmails.some((email) =>
    mention.emails.map((value) => value.normalize("NFKC").toLowerCase()).includes(email),
  );
  const profileUrls = unique(
    profile.profileUrls.map(normalizeProfileUrl).filter((value): value is string => value !== null),
  );
  const profileUrlMatched = profileUrls.some((url) => mention.profileUrls.includes(url));
  const profileHandles = normalizeHandles(profile.handles);
  const verifiedHandleMatched = Object.entries(normalizeHandles(mention.verifiedHandles)).some(
    ([platform, handles]) =>
      handles.some((handle) => (profileHandles[platform] ?? []).includes(handle)),
  );
  const profileExternalIds = new Set(
    normalizeExternalContactIds(profile.externalContactIds ?? []).map(
      (item) => `${item.system}:${item.externalId}`,
    ),
  );
  const externalContactMatched = normalizeExternalContactIds(mention.externalContactIds).some(
    (item) => profileExternalIds.has(`${item.system}:${item.externalId}`),
  );
  const speakerCalendarEmailMatched =
    mention.speakerCalendarEmail !== null &&
    profileEmails.includes(mention.speakerCalendarEmail.normalize("NFKC").toLowerCase());
  const profileRole = profile.role === null ? null : normalizeName(profile.role);
  const titleMatched =
    profileRole !== null &&
    mention.titles.some((title) => {
      const normalized = normalizeName(title);
      return profileRole.includes(normalized) || normalized.includes(profileRole);
    });
  const roleMatched =
    profileRole !== null &&
    mention.roles.some((role) => {
      const normalized = normalizeName(role);
      return profileRole.includes(normalized) || normalized.includes(profileRole);
    });
  const rosterContextMatched = mention.rosterContext.some((person) =>
    profileEmails.includes(person.email.normalize("NFKC").toLowerCase()),
  );
  const employers = unique(
    [profile.currentEmployer, ...profile.employerHints].filter(
      (value): value is string => value !== null,
    ),
  );
  const employerMatched =
    mention.organizationContext !== null &&
    employers.some((value) => normalizeName(value).includes(mention.organizationContext!));
  return [
    {
      signal: "exact-email",
      explanation:
        mention.emails.length === 0
          ? "The mention carries no email address."
          : emailMatched
            ? `The mention's email ${mention.emails[0]} exactly matches this Profile's email.`
            : `The mention's email ${mention.emails[0]} does not match this Profile's emails.`,
      matched: emailMatched,
      weight: WEIGHT_EXACT_EMAIL,
    },
    {
      signal: "exact-profile-url",
      explanation:
        mention.profileUrls.length === 0
          ? "The mention carries no canonical Profile URL."
          : profileUrlMatched
            ? `The canonical Profile URL ${mention.profileUrls[0]} exactly matches this Profile.`
            : `The canonical Profile URL ${mention.profileUrls[0]} does not match this Profile.`,
      matched: profileUrlMatched,
      weight: WEIGHT_EXACT_PROFILE_URL,
    },
    {
      signal: "verified-handle",
      explanation:
        Object.keys(mention.verifiedHandles).length === 0
          ? "The mention carries no source-verified handle."
          : verifiedHandleMatched
            ? "A source-verified handle exactly matches this Profile."
            : "The source-verified handles do not match this Profile.",
      matched: verifiedHandleMatched,
      weight: WEIGHT_VERIFIED_HANDLE,
    },
    {
      signal: "external-contact-id",
      explanation:
        mention.externalContactIds.length === 0
          ? "The mention carries no external contact identifier."
          : externalContactMatched
            ? "A provider-owned external contact identifier exactly matches this Profile."
            : "The external contact identifiers do not match this Profile.",
      matched: externalContactMatched,
      weight: WEIGHT_EXTERNAL_CONTACT_ID,
    },
    {
      signal: "speaker-calendar-email",
      explanation:
        mention.speakerCalendarEmail === null
          ? "The source speaker has no verified Calendar email mapping."
          : speakerCalendarEmailMatched
            ? `The source speaker maps to Calendar email ${mention.speakerCalendarEmail}, which exactly matches this Profile.`
            : `The source speaker's Calendar email ${mention.speakerCalendarEmail} does not match this Profile.`,
      matched: speakerCalendarEmailMatched,
      weight: WEIGHT_SPEAKER_CALENDAR_EMAIL,
    },
    {
      signal: "remembered-mapping",
      explanation:
        mapping.evidence.length === 0
          ? "No remembered mapping applies to this mention inside its scope."
          : mapping.evidence.some((authority) => authority.profileId === profile.id)
            ? mapping.conflicting
              ? "A remembered mapping points at this Profile, but another active lineage conflicts and requires review."
              : `Remembered mapping v${mapping.applicable?.mappingVersion} ties this name to the Profile inside its ${mapping.applicable?.scope} scope.`
            : "A remembered mapping applies to this name, but it points at a different Profile.",
      matched: mapping.evidence.some((authority) => authority.profileId === profile.id),
      weight: WEIGHT_REMEMBERED_MAPPING,
    },
    {
      signal: "normalized-full-name",
      explanation:
        profileName === null
          ? "The Profile has no full name to compare."
          : nameMatched
            ? `The normalized mention name "${mentionName}" matches the Profile name "${profileName}".`
            : `The normalized mention name "${mentionName}" does not match the Profile name.`,
      matched: nameMatched,
      weight: WEIGHT_FULL_NAME,
    },
    {
      signal: "alias",
      explanation:
        mention.aliases.length === 0
          ? "The extraction carries no aliases for this mention."
          : aliasMatched
            ? `The extracted alias "${mention.aliases[0]}" matches this Profile's name.`
            : "The extracted aliases do not match this Profile's name.",
      matched: aliasMatched,
      weight: WEIGHT_ALIAS,
    },
    {
      signal: "title",
      explanation:
        mention.titles.length === 0
          ? "The extraction carries no title for this mention."
          : titleMatched
            ? `The extracted title "${mention.titles[0]}" matches this Profile's role evidence.`
            : "The extracted titles do not match this Profile's role evidence.",
      matched: titleMatched,
      weight: WEIGHT_TITLE,
    },
    {
      signal: "role",
      explanation:
        mention.roles.length === 0
          ? "The extraction carries no contextual role for this mention."
          : roleMatched
            ? `The extracted role "${mention.roles[0]}" matches this Profile's role evidence.`
            : "The extracted roles do not match this Profile's role evidence.",
      matched: roleMatched,
      weight: WEIGHT_ROLE,
    },
    {
      signal: "roster-context",
      explanation:
        mention.rosterContext.length === 0
          ? "No Calendar roster attendee matches this mention's observed names."
          : rosterContextMatched
            ? `Calendar roster context connects this mention to ${mention.rosterContext[0]?.email}, which belongs to this Profile.`
            : "The matching Calendar roster entries do not belong to this Profile.",
      matched: rosterContextMatched,
      weight: WEIGHT_ROSTER_CONTEXT,
    },
    {
      signal: "speaker-label",
      explanation:
        mention.attendeeStatus !== "speaker"
          ? "The mention is not a source speaker label."
          : nameMatched
            ? "The mention is a source speaker label and the Profile carries the same name."
            : "The mention is a source speaker label, but the Profile carries a different name.",
      matched: mention.attendeeStatus === "speaker" && nameMatched,
      weight: WEIGHT_SPEAKER_LABEL,
    },
    {
      signal: "employer-hint",
      explanation:
        mention.organizationContext === null
          ? "The mention names no organization context."
          : employerMatched
            ? `The organization context "${mention.organizationContext}" matches this Profile's employer evidence.`
            : `The organization context "${mention.organizationContext}" does not match this Profile's employer evidence.`,
      matched: employerMatched,
      weight: WEIGHT_EMPLOYER_HINT,
    },
  ];
}

export function conflictsFor(
  mention: TranscriptMention,
  profile: PersonProfile,
  allProfiles: PersonProfile[],
  profileIdentifiers?: ReadonlyMap<string, StableIdentifier[]>,
): TranscriptCandidateConflict[] {
  const identifiersOf = (candidate: PersonProfile): StableIdentifier[] =>
    profileIdentifiers?.get(candidate.id) ?? profileStableIdentifiers(candidate);
  const conflicts: TranscriptCandidateConflict[] = [];
  if (profile.archivedAt !== null) {
    conflicts.push({
      kind: "archived-profile",
      explanation: "The Profile is archived; archived Profiles are never auto-linked.",
      hard: true,
    });
  }
  const profileStableKeys = new Set(identifiersOf(profile).map((item) => item.key));
  const mentionIdentifiers = mentionStableIdentifiers(mention);
  for (const identifier of mentionIdentifiers) {
    const owners = allProfiles.filter((candidate) =>
      identifiersOf(candidate).some((item) => item.key === identifier.key),
    );
    if (profileStableKeys.has(identifier.key) && owners.length > 1) {
      conflicts.push({
        kind: "duplicate-stable-id",
        explanation: `The exact ${identifier.kind} ${identifier.display} is owned by ${owners.length} Profiles.`,
        hard: true,
      });
    } else if (!profileStableKeys.has(identifier.key) && owners.length > 0) {
      conflicts.push({
        kind:
          identifier.kind === "email" ? "email-belongs-elsewhere" : "stable-id-belongs-elsewhere",
        explanation: `The exact ${identifier.kind} ${identifier.display} belongs to Profile ${owners[0]?.id}, not this one.`,
        hard: true,
      });
    }
  }
  for (const rosterPerson of mention.rosterContext) {
    const rosterEmail = rosterPerson.email.normalize("NFKC").toLowerCase();
    const owners = allProfiles.filter((candidate) =>
      identifiersOf(candidate).some((item) => item.key === `email:${rosterEmail}`),
    );
    if (owners.length > 0 && !owners.some((owner) => owner.id === profile.id)) {
      conflicts.push({
        kind: "roster-email-belongs-elsewhere",
        explanation: `The matching Calendar roster email ${rosterEmail} belongs to Profile ${owners[0]?.id}, not this one.`,
        hard: true,
      });
    }
  }
  if (mention.emails.length > 0) {
    const profileEmails = new Set(
      [...profile.emails, ...(profile.primaryEmail === null ? [] : [profile.primaryEmail])].map(
        (email) => email.normalize("NFKC").toLowerCase(),
      ),
    );
    const intersects = mention.emails.some((email) =>
      profileEmails.has(email.normalize("NFKC").toLowerCase()),
    );
    const identifierHasOwner = mentionIdentifiers.some(
      (identifier) =>
        identifier.kind === "email" &&
        allProfiles.some((candidate) =>
          identifiersOf(candidate).some((item) => item.key === identifier.key),
        ),
    );
    if (!intersects && !identifierHasOwner && profile.primaryEmail !== null) {
      conflicts.push({
        kind: "name-email-mismatch",
        explanation: `The mention carries email ${mention.emails[0]} but this Profile's primary email is ${profile.primaryEmail}.`,
        hard: false,
      });
    }
  }
  return conflicts;
}

export function policyClassOf(
  mention: TranscriptMention,
  signals: TranscriptCandidateSignal[],
  conflicts: TranscriptCandidateConflict[],
  leadOverNext: number | null,
  isTop: boolean,
): TranscriptCandidatePolicyClass {
  const hasHardConflict = conflicts.some((conflict) => conflict.hard);
  const stableIdentifierMatched = signals.some(
    (signal) =>
      [
        "exact-email",
        "exact-profile-url",
        "verified-handle",
        "external-contact-id",
        "speaker-calendar-email",
      ].includes(signal.signal) && signal.matched,
  );
  if (!hasHardConflict && stableIdentifierMatched) return "confirmed";
  if (mention.kind === "ambiguous-name" || hasHardConflict) return "ambiguous";
  const score = signals
    .filter((signal) => signal.matched)
    .reduce((sum, signal) => sum + signal.weight, 0);
  const decisive = leadOverNext === null || leadOverNext >= PROBABLE_MIN_LEAD;
  if (isTop && score >= PROBABLE_MIN_SCORE && decisive) return "probable";
  return "ambiguous";
}
