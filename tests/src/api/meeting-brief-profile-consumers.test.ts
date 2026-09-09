import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type {
  MeetingBriefPersonProfileReadModel,
  MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { openRuns } from "../../../apps/server/src/runs";

describe("Meeting Brief-owned Person Profile consumer read model", () => {
  it("derives refresh state without changing the immutable Run result", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-brief-profile-read-"));
    const runs = openRuns(workspaceDir);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(workspaceDir),
      now: () => new Date("2026-08-31T16:00:00.000Z"),
      lifecycle: [],
    });
    const profile = people.create({ fullName: "Grace Hopper", role: "Rear Admiral" });
    const run = runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "calendar",
      sourceUrl: null,
      externalId: "evt::occurrence",
    });
    const stored = fromPartial<MeetingBriefRunResult>({
      version: 1,
      personProfileLinks: [
        {
          guestEmail: "grace@example.com",
          profileId: profile.id,
          profileRevision: 1,
        },
      ],
    });
    run.writeArtifact("result.json", `${JSON.stringify(stored, null, 2)}\n`);
    people.correct(profile.id, { role: "Professor" });
    const host = new MeetingBriefHost({ runs, workspaceDir, personProfiles: people });
    const app = fastify({ logger: false });
    await host.routes(app);
    await app.ready();

    const response = await app.inject({
      url: `/api/meeting-brief/runs/${run.id}/profile-consumers`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<MeetingBriefPersonProfileReadModel>().consumers[0]).toMatchObject({
      link: {
        guestEmail: "grace@example.com",
        profileId: profile.id,
        profileRevision: 1,
      },
      state: {
        currentProfileId: profile.id,
        currentProfileRevision: 2,
        refreshRequired: true,
        invalidations: [{ kind: "correction", affectedRevision: 1 }],
      },
    });
    expect(JSON.parse(run.readArtifact("result.json")!)).toEqual(stored);
    await app.close();
  });
});
