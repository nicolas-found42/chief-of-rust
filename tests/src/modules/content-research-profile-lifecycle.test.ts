import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentResearchStore } from "../../../apps/server/src/modules/content-research/store";
import { ContentResearchWatchRegistry } from "../../../apps/server/src/modules/content-research/profile-registry";
import { WorkspacePersonProfileReferences } from "../../../apps/server/src/person-profile/references";
import {
  PersonProfileValidationError,
  WorkspacePersonProfiles,
} from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { openRuns } from "../../../apps/server/src/runs";

const NOW = () => new Date("2026-08-31T16:00:00.000Z");

interface Composition {
  profiles: WorkspacePersonProfiles;
  store: ContentResearchStore;
  withWatches: boolean;
}

/**
 * The full composition the Shell builds for the Profile lifecycle (#134): the
 * Workspace reference registry plus Content Research's own watch registry,
 * both asked on every archive, privacy-delete preview and purge. `withWatches`
 * is the mutation seam: composing without the watch registry is how a
 * regression that stops surfacing watches is caught.
 */
function compose(withWatches: boolean): Composition {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-research-lifecycle-"));
  const runs = openRuns(workspaceDir);
  const store = new ContentResearchStore(workspaceDir, NOW);
  const profiles = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [
      new WorkspacePersonProfileReferences(runs, {
        ownerReference: () => null,
        transcripts: () => [],
        publicItems: () => [],
      }),
      ...(withWatches ? [new ContentResearchWatchRegistry(store)] : []),
    ],
    now: NOW,
  });
  return { profiles, store, withWatches };
}

function watchAda(store: ContentResearchStore, profiles: WorkspacePersonProfiles): string {
  const profile = profiles.create({
    fullName: "Ada Lovelace",
    primaryEmail: "ada@example.com",
  });
  store.addPerson({ profileId: profile.id, name: "Ada Lovelace" });
  return profile.id;
}

describe("Content Research watches in the Profile lifecycle (#134)", () => {
  it("archive refuses while a watch is active, names the watch, and pausing unblocks it", () => {
    const { profiles, store } = compose(true);
    const profileId = watchAda(store, profiles);

    const refuse = () => profiles.archive(profileId);
    expect(refuse).toThrow(PersonProfileValidationError);
    try {
      profiles.archive(profileId);
      expect.unreachable("archive should have been refused");
    } catch (error) {
      const validation = error as PersonProfileValidationError;
      expect(validation.code).toBe("active-dependencies");
      const watch = validation.lifecycle?.dependentConfigurations.find(
        (dependency) => dependency.consumer === "content-research",
      );
      expect(watch).toMatchObject({
        consumer: "content-research",
        state: "active",
        availableActions: ["pause"],
        profileId,
      });
    }

    /* The required decision: pause the watch, then archive proceeds. The
       watch keeps its configuration — it is lifecycle state, not deletion. */
    store.pausePerson(store.listAllPeople()[0].id);
    const archived = profiles.archive(profileId);
    expect(archived.archivedAt).not.toBeNull();
    const pausedWatch = store.listAllPeople()[0];
    expect(pausedWatch.pausedAt).not.toBeNull();
    expect(pausedWatch.archivedAt).toBeNull();
  });

  it("a paused watch still shows in the lifecycle preview as resolved by re-pointing", () => {
    const { profiles, store } = compose(true);
    const profileId = watchAda(store, profiles);
    store.pausePerson(store.listAllPeople()[0].id);

    const preview = profiles.lifecycle(profileId);
    const watch = preview.dependentConfigurations.find(
      (dependency) => dependency.consumer === "content-research",
    );
    expect(watch).toMatchObject({ state: "paused", availableActions: ["repoint"] });
    /* Paused is not active: the Profile can now be archived. */
    expect(profiles.archive(profileId).archivedAt).not.toBeNull();
  });

  it("privacy deletion purges the paused watch's Profile reference and says so in the receipt", () => {
    const { profiles, store } = compose(true);
    const profileId = watchAda(store, profiles);
    store.pausePerson(store.listAllPeople()[0].id);

    const receipt = profiles.privacyDelete(profileId, { confirmation: "DELETE PROFILE" });
    expect(receipt.removed.activeLinks).toBe(1);
    /* The watch cannot outlive the Profile it was backed by. */
    const watch = store.listAllPeople()[0];
    expect(watch.archivedAt).not.toBeNull();
    expect(watch.profileId).toBe(profileId); /* kept as the archive's audit record */
  });

  it("composing without the watch registry would let an active watch be archived silently", () => {
    const { profiles, store } = compose(false);
    const profileId = watchAda(store, profiles);

    /* Mutation witness: without Content Research's registry, the lifecycle
       sees no dependent configuration and the archive succeeds — losing the
       disclosure the composition root is required to provide. */
    expect(profiles.archive(profileId).archivedAt).not.toBeNull();
  });
});
