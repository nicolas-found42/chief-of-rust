import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { composePersonProfiles } from "../../../apps/server/src/person-profile/composition.js";

it.each(["correction", "merge", "privacy deletion", "source detachment"])(
  "preserves %s through an in-flight extraction in the Person Profiles composition",
  async (change) => {
    const root = mkdtempSync(join(tmpdir(), "person-research-lifecycle-"));
    const quote = "Maya Chen built Atlas.";
    let entered!: () => void;
    let release!: (value: unknown) => void;
    const extracting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const people = composePersonProfiles({
      workspaceDir: root,
      search: async () => [],
      complete: () => () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
          entered();
        }),
      confirmedTranscripts: () => [],
      transcriptStillConfirmed: () => false,
      researchEnabled: () => true,
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          body: quote,
          etag: null,
          lastModified: null,
          retryAfter: null,
        }),
      },
    });
    try {
      const profile = people.research.startFor({
        fullName: "Maya Chen",
        profileUrls: ["https://example.com/maya"],
      });
      const pending = people.research.runNow(profile.id);
      await extracting;
      const source = people.research.sources(profile.id)[0];
      expect(source.text).toBe(quote);

      let survivorId: string | undefined;
      if (change === "correction")
        people.profiles.correct(profile.id, { fullName: "Another person", note: "Wrong identity" });
      if (change === "merge") {
        survivorId = people.profiles.create({ fullName: "Maya Chen" }).id;
        people.profiles.merge(survivorId, { duplicateId: profile.id });
      }
      if (change === "privacy deletion")
        people.profiles.privacyDelete(profile.id, { confirmation: "DELETE PROFILE" });
      if (change === "source detachment") {
        people.dossiers.detach(profile.id, source.id);
        people.profiles.forgetResearchSource(profile.id, source.id);
      }

      release({
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [
          {
            id: "atlas",
            section: "work",
            statement: quote,
            status: "supported",
            nature: "statement",
            matchConfidence: "high",
            effectiveFrom: null,
            effectiveTo: null,
            citations: [{ sourceId: "source", quote }],
            supports: [],
            supersedes: [],
            changeReason: null,
          },
        ],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      });
      await pending;

      expect(people.research.dossier(profile.id)?.claims ?? []).toEqual([]);
      expect(people.research.outcome(profile.id)?.conclusion).not.toBe("completed");
      if (change === "correction")
        expect(people.profiles.get(profile.id)?.fullName).toBe("Another person");
      if (survivorId) {
        expect(people.profiles.get(profile.id)?.mergedInto).toBe(survivorId);
        expect(people.research.dossier(survivorId)?.claims ?? []).toEqual([]);
      }
      if (change === "privacy deletion") {
        expect(people.profiles.get(profile.id)).toBeNull();
        expect(people.research.sources(profile.id)).toEqual([]);
        expect(people.research.attempts(profile.id)).toEqual([]);
        expect(readFileSync(join(root, "person-research.json"), "utf8")).not.toContain(profile.id);
      }
      if (change === "source detachment")
        expect(people.research.sources(profile.id)).not.toContainEqual(
          expect.objectContaining({ id: source.id }),
        );
    } finally {
      people.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
