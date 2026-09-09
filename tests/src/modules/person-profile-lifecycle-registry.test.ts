import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspacePersonProfileReferences } from "../../../apps/server/src/person-profile/references";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { openRuns } from "../../../apps/server/src/runs";

describe("Workspace-owned Person Profile reference registry", () => {
  it("purges active links and person snapshots without deleting unrelated Run history", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "person-profile-references-"));
    const runs = openRuns(workspaceDir);
    const store = new PersonProfileStore(workspaceDir);
    const profiles = new WorkspacePersonProfiles({
      store,
      lifecycle: [
        new WorkspacePersonProfileReferences(runs, {
          ownerReference: () => null,
          transcripts: () => [],
          publicItems: () => [],
        }),
      ],
      now: () => new Date("2026-08-31T16:00:00.000Z"),
    });
    const profile = profiles.create({
      fullName: "Ada Lovelace",
      primaryEmail: "ada@example.com",
    });
    const run = runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "calendar",
      sourceUrl: null,
      externalId: "evt::occurrence",
    });
    run.writeArtifact(
      "result.json",
      `${JSON.stringify({
        version: 1,
        immutableSummary: "The rest of this Run remains an audit record.",
        personProfileLinks: [
          {
            guestEmail: "ada@example.com",
            profileId: profile.id,
            profileRevision: 2,
          },
          {
            guestEmail: "grace@example.com",
            profileId: "person_grace",
            profileRevision: 1,
          },
        ],
      })}\n`,
    );
    run.writeArtifact(
      "attendee-profiles.json",
      `${JSON.stringify([
        { email: "ada@example.com", profileId: profile.id, profileRevision: 2 },
        { email: "grace@example.com", profileId: "person_grace", profileRevision: 1 },
      ])}\n`,
    );
    run.writeArtifact(
      "person-profile-ada-v2.json",
      `${JSON.stringify({ profileId: profile.id, fullName: "Ada Lovelace" })}\n`,
    );
    run.writeArtifact(
      "person-profile-grace-v1.json",
      `${JSON.stringify({ profileId: "person_grace", fullName: "Grace Hopper" })}\n`,
    );

    const receipt = profiles.privacyDelete(profile.id, { confirmation: "DELETE PROFILE" });

    expect(receipt.removed.activeLinks).toBe(2);
    expect(receipt.removed.personSnapshots).toBe(1);
    expect(JSON.parse(run.readArtifact("result.json")!)).toEqual({
      version: 1,
      immutableSummary: "The rest of this Run remains an audit record.",
      personProfileLinks: [
        {
          guestEmail: "grace@example.com",
          profileId: "person_grace",
          profileRevision: 1,
        },
      ],
    });
    expect(JSON.parse(run.readArtifact("attendee-profiles.json")!)).toEqual([
      { email: "grace@example.com", profileId: "person_grace", profileRevision: 1 },
    ]);
    expect(run.readArtifact("person-profile-ada-v2.json")).toBeNull();
    expect(run.readArtifact("person-profile-grace-v1.json")).not.toBeNull();
  });
});
