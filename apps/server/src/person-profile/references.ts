import type {
  ConfirmedOwnerReference,
  PersonProfile,
  PersonProfileDependentConfiguration,
  PersonProfileResidualSourceArtifact,
  SourceItem,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import type {
  PersonProfileLifecycleInspection,
  PersonProfileLifecycleRegistry,
  PersonProfileRegistryDeletionCounts,
} from "./profiles.js";
import type { Runs } from "../runs.js";

interface ProfileReference {
  profileId?: unknown;
}

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Where the registry reads the Workspace state a disclosure is derived from.
    Every source is a local store; nothing here reaches a remote provider. */
export interface PersonProfileReferenceSources {
  /** The confirmed owner reference, or null while onboarding is unconfirmed. */
  ownerReference: () => ConfirmedOwnerReference | null;
  /** Every catalogued immutable transcript in the Workspace. */
  transcripts: () => TranscriptRecord[];
  /** Every collected public source item in the Workspace. */
  publicItems: () => SourceItem[];
}

/** Case-insensitive containment of any identity needle in free text. */
function mentionsAny(text: string, needles: string[]): boolean {
  const haystack = text.toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Workspace-owned registry for the Profile references already held by
 * immutable Runs, by the confirmed owner reference, and by the immutable
 * source documents (catalogued transcripts, collected public source items)
 * that name the person. `inspect` derives the disclosure the lifecycle
 * surfaces refuse and confirm with; privacy deletion is the explicit
 * exception that removes Profile pins and projection snapshots while leaving
 * every unrelated Run field and artifact intact. It performs only local
 * store reads and `Runs` operations.
 */
export class WorkspacePersonProfileReferences implements PersonProfileLifecycleRegistry {
  constructor(
    private readonly runs: Runs,
    private readonly sources: PersonProfileReferenceSources,
  ) {}

  inspect(profile: PersonProfile): PersonProfileLifecycleInspection {
    /* The confirmed owner reference is the one standing active consumer of a
       Profile at this head: the owner's identity anchor. Meeting Brief
       references are historical consumer pins, not active configuration, and
       Content Research watches people by name — it holds no Profile
       reference at all. */
    const owner = this.sources.ownerReference();
    const dependentConfigurations: PersonProfileDependentConfiguration[] =
      owner && owner.profileId === profile.id
        ? [
            {
              id: "owner-reference",
              consumer: "owner-onboarding",
              label: "Confirmed owner Profile",
              state: "active",
              availableActions: ["repoint"],
              profileId: profile.id,
            },
          ]
        : [];

    /* Immutable source material is disclosed as references — which document,
       of what kind — never by title, because the disclosure outlives the
       identity the document may still name. Neither kind has a separate
       deletion surface yet, so neither claims one. */
    const needles = [profile.fullName, ...profile.emails]
      .filter((value): value is string => value !== null)
      .map((value) => value.toLowerCase());
    const residualSourceArtifacts: PersonProfileResidualSourceArtifact[] = [];
    if (needles.length > 0) {
      for (const record of this.sources.transcripts()) {
        const named =
          mentionsAny(record.normalizedText, needles) ||
          record.speakers.some((speaker) => needles.includes(speaker.toLowerCase()));
        if (named)
          residualSourceArtifacts.push({
            artifactId: record.id,
            kind: "transcript",
            separateDeleteSupported: false,
          });
      }
      for (const item of this.sources.publicItems()) {
        const fields = [item.title, item.body, item.description].filter(
          (field): field is string => field !== null,
        );
        if (fields.some((field) => mentionsAny(field, needles)))
          residualSourceArtifacts.push({
            artifactId: item.id,
            kind: "public-source",
            separateDeleteSupported: false,
          });
      }
    }
    return { dependentConfigurations, residualSourceArtifacts };
  }

  privacyDelete(profileId: string): PersonProfileRegistryDeletionCounts {
    let activeLinks = 0;
    let personSnapshots = 0;
    for (const summary of this.runs.list().runs) {
      const run = this.runs.open(summary.id);
      if (!run) continue;

      const result = parsed(run.readArtifact("result.json"));
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const record = result as Record<string, unknown>;
        if (Array.isArray(record.personProfileLinks)) {
          const kept = record.personProfileLinks.filter((link) => {
            const matches =
              link !== null &&
              typeof link === "object" &&
              (link as ProfileReference).profileId === profileId;
            if (matches) activeLinks += 1;
            return !matches;
          });
          if (kept.length !== record.personProfileLinks.length) {
            run.writeArtifact(
              "result.json",
              `${JSON.stringify({ ...record, personProfileLinks: kept }, null, 2)}\n`,
            );
          }
        }
      }

      const pins = parsed(run.readArtifact("attendee-profiles.json"));
      if (Array.isArray(pins)) {
        const kept = pins.filter((pin) => {
          const matches =
            pin !== null &&
            typeof pin === "object" &&
            (pin as ProfileReference).profileId === profileId;
          if (matches) activeLinks += 1;
          return !matches;
        });
        if (kept.length !== pins.length) {
          if (kept.length === 0) run.deleteArtifact("attendee-profiles.json");
          else run.writeArtifact("attendee-profiles.json", `${JSON.stringify(kept, null, 2)}\n`);
        }
      }

      for (const name of this.runs.detail(summary.id)?.files ?? []) {
        if (!name.startsWith("person-profile-") || !name.endsWith(".json")) continue;
        const snapshot = parsed(run.readArtifact(name));
        if (
          snapshot !== null &&
          typeof snapshot === "object" &&
          !Array.isArray(snapshot) &&
          (snapshot as ProfileReference).profileId === profileId
        ) {
          run.deleteArtifact(name);
          personSnapshots += 1;
        }
      }
    }
    return {
      aliases: 0,
      candidates: 0,
      mappings: 0,
      decisions: 0,
      activeLinks,
      personSnapshots,
    };
  }
}
