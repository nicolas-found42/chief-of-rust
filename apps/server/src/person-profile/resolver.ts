import { createHash } from "node:crypto";
import type {
  PersonEvidence,
  PersonEvidenceCandidate,
  PersonIdentitySignals,
  PersonProfile,
  PersonProfileMatchConfidence,
  PersonProfileSourceDiagnostic,
  PersonSocialProfile,
} from "@chief-of-staff-demo/shared";
import type { PersonProfileStore } from "./store.js";

interface PersonProfileSourceResult {
  candidates: PersonEvidenceCandidate[];
  diagnostic: Omit<PersonProfileSourceDiagnostic, "source">;
}

export interface PersonProfileSource {
  readonly id: string;
  collect(signals: PersonIdentitySignals): Promise<PersonProfileSourceResult>;
}

interface PersonProfiles {
  resolve(signals: PersonIdentitySignals): Promise<PersonProfile>;
  get(profileId: string): PersonProfile | null;
}

interface MatchResult {
  confidence: PersonProfileMatchConfidence;
  matchedSignals: string[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeEmail(value: string): string {
  return normalize(value);
}

function normalizeHandle(value: string): string {
  return normalize(value).replace(/^@/, "");
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizedSignals(signals: PersonIdentitySignals): PersonIdentitySignals {
  const handles: Record<string, string[]> = {};
  for (const [platform, values] of Object.entries(signals.handles)) {
    const normalizedValues = unique(values.map(normalizeHandle));
    if (normalizedValues.length > 0) handles[normalize(platform)] = normalizedValues;
  }
  return {
    emails: unique(signals.emails.map(normalizeEmail)),
    fullNames: unique(signals.fullNames.map(normalize)),
    handles,
    profileUrls: unique(
      signals.profileUrls.map(normalizeUrl).filter((value): value is string => !!value),
    ),
    employerHints: unique(signals.employerHints.map(normalize)),
  };
}

function overlap(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

export function matchPersonEvidence(
  requested: PersonIdentitySignals,
  observed: PersonIdentitySignals,
): MatchResult | null {
  const input = normalizedSignals(requested);
  const candidate = normalizedSignals(observed);
  const matchedSignals: string[] = [];
  const emailMatches = overlap(input.emails, candidate.emails);
  matchedSignals.push(...emailMatches.map((value) => `email:${value}`));
  const urlMatches = overlap(input.profileUrls, candidate.profileUrls);
  matchedSignals.push(...urlMatches.map((value) => `profileUrl:${value}`));
  const handleMatches: string[] = [];
  for (const [platform, values] of Object.entries(input.handles)) {
    const matches = overlap(values, candidate.handles[platform] ?? []);
    handleMatches.push(...matches.map((value) => `${platform}:${value}`));
  }
  matchedSignals.push(...handleMatches.map((value) => `handle:${value}`));
  const nameMatches = overlap(input.fullNames, candidate.fullNames);
  matchedSignals.push(...nameMatches.map((value) => `fullName:${value}`));
  const employerMatches = overlap(input.employerHints, candidate.employerHints);
  matchedSignals.push(...employerMatches.map((value) => `employer:${value}`));

  const contradictoryEmail =
    input.emails.length > 0 && candidate.emails.length > 0 && emailMatches.length === 0;
  const contradictoryHandle = Object.entries(input.handles).some(([platform, values]) => {
    const observedHandles = candidate.handles[platform] ?? [];
    return observedHandles.length > 0 && overlap(values, observedHandles).length === 0;
  });
  if (
    (contradictoryEmail || contradictoryHandle) &&
    emailMatches.length + handleMatches.length === 0
  )
    return null;
  if (emailMatches.length > 0 || urlMatches.length > 0 || handleMatches.length > 0)
    return { confidence: "high", matchedSignals: unique(matchedSignals) };
  if (nameMatches.length > 0 && employerMatches.length > 0)
    return { confidence: "high", matchedSignals: unique(matchedSignals) };
  if (nameMatches.length > 0)
    return { confidence: "medium", matchedSignals: unique(matchedSignals) };
  return null;
}

export function identifier(signals: PersonIdentitySignals): string {
  const normalized = normalizedSignals(signals);
  const key =
    normalized.emails[0] ??
    Object.entries(normalized.handles)[0]?.join(":") ??
    normalized.profileUrls[0] ??
    normalized.fullNames[0] ??
    "person";
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `person_${digest}`;
}

function evidenceId(candidate: PersonEvidenceCandidate): string {
  return createHash("sha256")
    .update(`${candidate.source}\n${candidate.kind}\n${candidate.url}\n${candidate.summary}`)
    .digest("hex")
    .slice(0, 16);
}

function mergeSignals(
  existing: PersonProfile | null,
  input: PersonIdentitySignals,
): PersonIdentitySignals {
  const mergedHandles: Record<string, string[]> = { ...(existing?.handles ?? {}) };
  for (const [platform, values] of Object.entries(input.handles)) {
    mergedHandles[normalize(platform)] = unique([
      ...(mergedHandles[normalize(platform)] ?? []),
      ...values.map(normalizeHandle),
    ]);
  }
  return normalizedSignals({
    emails: [...(existing?.emails ?? []), ...input.emails],
    fullNames: [existing?.fullName ?? "", ...input.fullNames],
    handles: mergedHandles,
    profileUrls: [...(existing?.profileUrls ?? []), ...input.profileUrls],
    employerHints: [...(existing?.employerHints ?? []), ...input.employerHints],
  });
}

function resolvedClaim(
  evidence: PersonEvidence[],
  field: keyof PersonEvidenceCandidate["claims"],
): { observed: boolean; value: string | null } {
  const high = evidence
    .filter((item) => item.matchConfidence === "high")
    .map((item) => item.claims[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const distinct = new Map(high.map((value) => [normalize(value), value.trim()]));
  return {
    observed: distinct.size > 0,
    value: distinct.size === 1 ? ([...distinct.values()][0] ?? null) : null,
  };
}

const SOCIAL_HOSTS: Record<string, string> = {
  "bsky.app": "bluesky",
  "facebook.com": "facebook",
  "github.com": "github",
  "instagram.com": "instagram",
  "linkedin.com": "linkedin",
  "mastodon.social": "mastodon",
  "threads.net": "threads",
  "tiktok.com": "tiktok",
  "x.com": "x",
  "youtube.com": "youtube",
};

function socialProfile(item: PersonEvidence): PersonSocialProfile | null {
  if (item.kind !== "social-profile" || item.matchConfidence !== "high") return null;
  try {
    const url = new URL(item.url);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const platform = SOCIAL_HOSTS[hostname] ?? hostname;
    const pathHandle = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/^@/, "") ?? null;
    const known = item.identitySignals.handles[platform]?.[0];
    return { platform, handle: known ? normalizeHandle(known) : pathHandle, url: item.url };
  } catch {
    return null;
  }
}

export class PersonProfileResolver implements PersonProfiles {
  constructor(
    private readonly deps: {
      store: PersonProfileStore;
      sources: PersonProfileSource[];
      now?: () => Date;
    },
  ) {}

  get(profileId: string): PersonProfile | null {
    return this.deps.store.get(profileId);
  }

  /**
   * Collect from every source and compose the Profile the evidence supports,
   * without writing it. `resolve` saves what this returns; the typed-identifier
   * lookup shows it as a proposal first, so a bad match costs nothing.
   */
  async preview(input: PersonIdentitySignals): Promise<PersonProfile> {
    return await this.build(input);
  }

  async resolve(input: PersonIdentitySignals): Promise<PersonProfile> {
    const profile = await this.build(input);
    this.deps.store.save(profile);
    return profile;
  }

  private async build(input: PersonIdentitySignals): Promise<PersonProfile> {
    const signals = normalizedSignals(input);
    if (
      signals.emails.length === 0 &&
      signals.fullNames.length === 0 &&
      Object.keys(signals.handles).length === 0 &&
      signals.profileUrls.length === 0
    )
      throw new Error("At least one Person Profile Identity Signal is required.");
    const existing = this.deps.store.findBySignals(signals);
    const mergedSignals = mergeSignals(existing, signals);
    const observedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    const results = await Promise.all(
      this.deps.sources.map(async (source) => {
        try {
          const result = await source.collect(mergedSignals);
          return {
            ...result,
            diagnostic: { source: source.id, ...result.diagnostic },
          };
        } catch (error) {
          return {
            candidates: [],
            diagnostic: {
              source: source.id,
              status: "failed" as const,
              detail: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }),
    );
    const collected = results.flatMap((result) =>
      result.candidates.flatMap((candidate): PersonEvidence[] => {
        const match = matchPersonEvidence(mergedSignals, candidate.identitySignals);
        if (!match) return [];
        return [
          {
            ...candidate,
            id: evidenceId(candidate),
            matchConfidence: match.confidence,
            matchedSignals: match.matchedSignals,
            observedAt,
          },
        ];
      }),
    );
    const evidenceById = new Map(
      [...(existing?.evidence ?? []), ...collected].map((item) => [item.id, item]),
    );
    const evidence = [...evidenceById.values()];
    const highConfidenceSignals = evidence
      .filter((item) => item.matchConfidence === "high")
      .map((item) => item.identitySignals);
    const resolvedSignals = mergeSignals(existing, {
      emails: [...input.emails, ...highConfidenceSignals.flatMap((item) => item.emails)],
      fullNames: [...input.fullNames, ...highConfidenceSignals.flatMap((item) => item.fullNames)],
      handles: highConfidenceSignals.reduce<Record<string, string[]>>(
        (all, item) => {
          for (const [platform, values] of Object.entries(item.handles))
            all[platform] = [...(all[platform] ?? []), ...values];
          return all;
        },
        { ...input.handles },
      ),
      profileUrls: [
        ...input.profileUrls,
        ...highConfidenceSignals.flatMap((item) => item.profileUrls),
      ],
      employerHints: [
        ...input.employerHints,
        ...highConfidenceSignals.flatMap((item) => item.employerHints),
      ],
    });
    const fullNameClaim = resolvedClaim(evidence, "fullName");
    const roleClaim = resolvedClaim(evidence, "role");
    const backgroundClaim = resolvedClaim(evidence, "background");
    const employerClaim = resolvedClaim(evidence, "currentEmployer");
    const suppliedFullName = input.fullNames.find((value) => value.trim())?.trim();
    const fullName =
      suppliedFullName ??
      (fullNameClaim.observed ? fullNameClaim.value : (existing?.fullName ?? null));
    const socialProfiles = [
      ...new Map(
        evidence
          .map(socialProfile)
          .filter((value): value is PersonSocialProfile => value !== null)
          .map((value) => [value.url, value]),
      ).values(),
    ];
    const profile: PersonProfile = {
      archivedAt: existing?.archivedAt ?? null,
      id: existing?.id ?? identifier(mergedSignals),
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? observedAt,
      updatedAt: observedAt,
      fullName,
      primaryEmail: resolvedSignals.emails[0] ?? null,
      emails: resolvedSignals.emails,
      handles: resolvedSignals.handles,
      profileUrls: unique([
        ...resolvedSignals.profileUrls,
        ...socialProfiles.map((item) => item.url),
      ]),
      employerHints: resolvedSignals.employerHints,
      role: roleClaim.observed ? roleClaim.value : (existing?.role ?? null),
      background: backgroundClaim.observed ? backgroundClaim.value : (existing?.background ?? null),
      currentEmployer: employerClaim.observed
        ? employerClaim.value
        : (existing?.currentEmployer ?? null),
      socialProfiles,
      websites: unique(
        evidence
          .filter((item) => item.kind === "website" && item.matchConfidence === "high")
          .map((item) => item.url),
      ),
      feeds: [
        ...new Map(
          evidence
            .filter((item) => item.kind === "feed" && item.matchConfidence === "high")
            .map((item) => [item.url, { url: item.url, title: item.title || null }]),
        ).values(),
      ],
      publications: evidence.filter((item) => item.kind === "publication"),
      mentions: evidence.filter((item) => item.kind === "mention"),
      evidence,
      sourceDiagnostics: results.map((result) => result.diagnostic),
    };
    return profile;
  }
}
