import type { PersonDossierStore } from "./dossier-store.js";
import type {
  PersonProfileLifecycleRegistry,
  PersonProfileRegistryDeletionCounts,
} from "./profiles.js";

/**
 * Lifecycle disclosure for the Person Dossier store. Residual artifacts are
 * every source the dossier still retains — not only the sources some surviving
 * claim cites: a zero-claim retained page still names the person (#204).
 * Deletion purges the store and the research queue entry; the queue is reached
 * through the remove callback because the queue is composed after the profiles
 * it schedules.
 */
export function personDossierRegistry(
  dossiers: PersonDossierStore,
  removeResearchEntry: (profileId: string) => void,
): PersonProfileLifecycleRegistry {
  return {
    inspect: (profile) => ({
      dependentConfigurations: [],
      residualSourceArtifacts: [...new Set(dossiers.get(profile.id)?.sourceIds ?? [])].map(
        (artifactId) => ({
          artifactId,
          kind: "public-source" as const,
          separateDeleteSupported: false,
        }),
      ),
    }),
    privacyDelete: (profileId): PersonProfileRegistryDeletionCounts => {
      const existed = dossiers.get(profileId) !== null;
      dossiers.privacyDelete(profileId);
      removeResearchEntry(profileId);
      return {
        aliases: 0,
        candidates: 0,
        mappings: 0,
        decisions: 0,
        activeLinks: 0,
        personSnapshots: existed ? 1 : 0,
      };
    },
  };
}
