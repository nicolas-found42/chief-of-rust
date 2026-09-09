import type {
  PersonProfile,
  PersonProfileDependentConfiguration,
} from "@chief-of-staff-demo/shared";
import type {
  PersonProfileLifecycleInspection,
  PersonProfileLifecycleRegistry,
  PersonProfileRegistryDeletionCounts,
} from "../../person-profile/profiles.js";
import type { ContentResearchStore } from "./store.js";

/**
 * Content Research's own share of the Profile lifecycle (spec #134, ADR-0042):
 * the Module owns its watches, so it registers them as dependent
 * configurations itself rather than letting the Profile product area reach
 * into its store. Archive and privacy deletion refuse while a watch is active;
 * privacy deletion purges the reference by archiving the watch — a watch
 * cannot exist without the Profile it is backed by.
 */
export class ContentResearchWatchRegistry implements PersonProfileLifecycleRegistry {
  constructor(private readonly store: ContentResearchStore) {}

  inspect(profile: PersonProfile): PersonProfileLifecycleInspection {
    const dependentConfigurations: PersonProfileDependentConfiguration[] = this.store
      .watchReferences()
      .filter((watch) => watch.profileId === profile.id);
    return { dependentConfigurations, residualSourceArtifacts: [] };
  }

  privacyDelete(profileId: string): PersonProfileRegistryDeletionCounts {
    return {
      aliases: 0,
      candidates: 0,
      mappings: 0,
      decisions: 0,
      activeLinks: this.store.removeProfileReferences(profileId),
      personSnapshots: 0,
    };
  }
}
