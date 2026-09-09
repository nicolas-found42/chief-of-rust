import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePersonProfiles } from "../../../apps/server/src/person-profile/composition.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { expect, it } from "vitest";
import { modelBoundaryFailure } from "../../../apps/server/src/llm/failure.js";
it.each([false, true])(
  "counts retained versions across failed resumes and refresh (legacy=%s)",
  async (legacy) => {
    const root = mkdtempSync(join(tmpdir(), "resume-proof-"));
    let calls = 0,
      fetches = 0;
    const quote = "Maya Chen built Atlas.";
    const options = {
      workspaceDir: root,
      search: async () => [],
      complete: () => async () => {
        calls++;
        if (calls <= 2)
          throw modelBoundaryFailure({
            call: { provider: "openrouter", model: "test", binding: "forced_tool_call" },
            classification: "request_timeout",
            timeoutMs: 120000,
          });
        return {
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
        };
      },
      confirmedTranscripts: () => [],
      transcriptStillConfirmed: () => false,
      researchEnabled: () => true,
      researchTestPorts: {
        fetch: async (url: string) => {
          fetches++;
          return {
            url,
            status: 200,
            contentType: "text/plain",
            body: quote,
            etag: null,
            lastModified: null,
            retryAfter: null,
          };
        },
      },
    };
    let people = composePersonProfiles(options);
    try {
      const profile = people.research.startFor({
        fullName: "Maya Chen",
        profileUrls: ["https://example.com/maya"],
      });
      const first = await people.research.runNow(profile.id);
      expect(first?.conclusion).toBe("interrupted");
      expect(first?.sourcesRetained).toBe(1);
      expect(first?.retainedSourceIds).toEqual(
        people.research.sources(profile.id).map((source) => source.id),
      );
      expect(first?.publishedDossierRevision).toBe(people.research.dossier(profile.id)?.revision);
      const checkpoint = JSON.parse(readFileSync(join(root, "person-research.json"), "utf8")) as {
        jobs: { sources: number; checkpoint: { retainedSourceIds: string[] } }[];
      };
      expect(checkpoint.jobs[0].checkpoint.retainedSourceIds).toEqual(first?.retainedSourceIds);
      expect(checkpoint.jobs[0].sources).toBe(1);
      people.stop();
      if (legacy) {
        const path = join(root, "person-research.json");
        const old = JSON.parse(readFileSync(path, "utf8")) as {
          jobs: {
            operation: { retainedSourceIds?: string[] };
            checkpoint: { retainedSourceIds?: string[] };
          }[];
        };
        delete old.jobs[0].operation.retainedSourceIds;
        delete old.jobs[0].checkpoint.retainedSourceIds;
        writeFileSync(path, JSON.stringify(old));
      }
      people = composePersonProfiles(options);
      const second = await people.research.runNow(profile.id);
      expect(second?.conclusion).toBe("interrupted");
      expect(second?.operationId).toBe(first?.operationId);
      expect(second?.sourcesRetained).toBe(1);
      expect(second?.retainedSourceIds).toEqual(legacy ? undefined : first?.retainedSourceIds);
      const recovered = await people.research.runNow(profile.id);
      expect(recovered?.conclusion).toBe("completed");
      expect(recovered?.operationId).toBe(first?.operationId);
      expect(recovered?.sourcesRetained).toBe(2);
      expect(recovered?.retainedSourceIds?.length).toBe(legacy ? undefined : 2);
      expect(recovered?.publishedDossierRevision).toBe(
        people.research.dossier(profile.id)?.revision,
      );
      expect(fetches).toBe(1);
      expect(people.research.dossier(profile.id)?.claims[0].statement).toBe(quote);
      const store = new PersonDossierStore(root);
      const originalSource = people.research.sources(profile.id)[0];
      const unrelated = store.retainSource({
        ...originalSource,
        url: "https://example.com/unrelated",
        text: "Unrelated historical source.",
      });
      const dossier = store.get(profile.id)!;
      store.publish(profile.id, dossier.revision, {
        ...dossier,
        sourceIds: [...dossier.sourceIds, unrelated.id],
      });
      const refresh = await people.research.runNow(profile.id);
      expect(refresh?.operationId).not.toBe(first?.operationId);
      expect(refresh?.conclusion).toBe("completed");
      expect(refresh?.sourcesRetained).toBe(2);
      expect(refresh?.retainedSourceIds).not.toContain(unrelated.id);
      expect(people.research.sources(profile.id)).toHaveLength(3);
      expect(refresh?.publishedDossierRevision).toBe(people.research.dossier(profile.id)?.revision);
      const saved = JSON.parse(readFileSync(join(root, "person-research.json"), "utf8")) as {
        jobs: { sources: number }[];
      };
      expect(saved.jobs[0].sources).toBe(2);
      expect(calls).toBe(4);
      expect(fetches).toBe(2);
    } finally {
      people.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
