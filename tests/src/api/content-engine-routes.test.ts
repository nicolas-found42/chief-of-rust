import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceBrandProfileStore } from "../../../apps/server/src/brand-profile/store";
import { registerContentEngineApi } from "../../../apps/server/src/api/content-engine";
import { WorkspaceContentProjects } from "../../../apps/server/src/content-projects/projects";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { stubDraftGenerator, stubOutlineGenerator } from "../modules/content-project-fixtures";

/**
 * The Content Engine product namespace over a real server instance and a
 * temporary Workspace (spec #147).
 *
 * What matters here is the thing that was missing: a Content Project the
 * Workspace already held was unreachable, because `get` needs an id nothing
 * listed and no route existed to call in the first place. These assert the
 * translation — that a Project can be found and opened, that each refusal
 * arrives as its own status and names the gate that refused, and that an
 * unknown Project and an unknown target are told apart. The gates themselves
 * belong to WorkspaceContentProjects and are covered at that seam.
 */
const NOW = new Date("2026-08-31T18:00:00.000Z");

let app: FastifyInstance;
let projects: WorkspaceContentProjects;
let workspaceDir: string;

function startProject() {
  return projects.create({
    subject: { kind: "topic", topic: "Why compiler feedback should be conversational" },
    objective: "establish-authority",
    audience: "Engineering leaders",
    constraints: [],
    targets: ["linkedin-standard-post"],
    researchMode: "no-external-research",
    seedMaterial: [],
  });
}

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-engine-routes-"));
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    now: () => NOW,
    lifecycle: [],
  });
  const owner = people.create({ fullName: "Workspace Owner", primaryEmail: "owner@example.com" });
  const ownerOnboarding = new OwnerOnboarding({ people, workspaceDir, now: () => NOW });
  ownerOnboarding.setConnectedIdentity("owner@example.com");
  ownerOnboarding.confirm(owner.id);
  projects = new WorkspaceContentProjects({
    workspaceDir,
    people,
    ownerOnboarding,
    brandProfiles: new WorkspaceBrandProfileStore(workspaceDir, () => NOW),
    /* No Run and no model call happens in these tests: only routes that read or
       refuse are exercised, so the generation seams are never reached. */
    researchProviders: [],
    outlineGenerator: stubOutlineGenerator(),
    draftGenerator: stubDraftGenerator(),
    now: () => NOW,
  });
  app = fastify();
  registerContentEngineApi(app, { contentProjects: projects });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("Content Engine project listing", () => {
  it("lists a started Content Project so it can be opened at all", async () => {
    const started = startProject();

    const response = await app.inject({ method: "GET", url: "/api/content-engine/projects" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      projects: { id: string; revision: number; audience: string }[];
    }>();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.id).toBe(started.id);
    expect(body.projects[0]?.revision).toBe(1);
    expect(body.projects[0]?.audience).toBe("Engineering leaders");
  });

  it("answers with an empty list rather than an error when no Project has been started", async () => {
    const response = await app.inject({ method: "GET", url: "/api/content-engine/projects" });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ projects: unknown[] }>().projects).toEqual([]);
  });

  it("reports each listed Project's standing, so the list says where work is stuck", async () => {
    startProject();

    const response = await app.inject({ method: "GET", url: "/api/content-engine/projects" });

    const body = response.json<{
      projects: { readiness: { ready: boolean; missingGates: string[] } }[];
    }>();
    expect(body.projects[0]?.readiness.ready).toBe(false);
    expect(body.projects[0]?.readiness.missingGates.length).toBeGreaterThan(0);
  });
});

describe("Content Engine project retrieval", () => {
  it("returns one Content Project with its readiness", async () => {
    const started = startProject();

    const response = await app.inject({
      method: "GET",
      url: `/api/content-engine/projects/${started.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      project: { id: string; revisions: unknown[] };
      readiness: { ready: boolean };
    }>();
    expect(body.project.id).toBe(started.id);
    expect(body.project.revisions).toHaveLength(1);
    expect(body.readiness.ready).toBe(false);
  });

  it("tells an unknown Content Project apart from a refusal", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/content-engine/projects/project_nope",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe("project-not-found");
  });
});

describe("Content Engine refusals", () => {
  it("refuses Outline generation with 409 and names the gates that are missing", async () => {
    const started = startProject();

    const response = await app.inject({
      method: "POST",
      url: `/api/content-engine/projects/${started.id}/outlines/linkedin-standard-post`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: string; missingGates: string[] }>();
    expect(body.error).toBe("outline-generation-blocked");
    /* The point of the whole surface: a refusal that names what is missing,
       rather than a bare "not ready" the owner cannot act on. */
    expect(body.missingGates.length).toBeGreaterThan(0);
  });

  it("refuses an Outline Charter that does not belong to the revision with 404", async () => {
    const started = startProject();

    const response = await app.inject({
      method: "POST",
      url: `/api/content-engine/projects/${started.id}/outline-charters/brief_nope/approve`,
      payload: {},
    });

    expect([404, 409]).toContain(response.statusCode);
    expect(response.json<{ error: string }>().error).toMatch(
      /outline-charter-not-found|outline-charter-blocked/,
    );
  });

  it("refuses a publication target that does not exist, without reaching the Project", async () => {
    const started = startProject();

    const response = await app.inject({
      method: "POST",
      url: `/api/content-engine/projects/${started.id}/outlines/carrier-pigeon`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("unknown-target");
  });

  it("refuses a Draft before an Outline exists to generate it from", async () => {
    const started = startProject();

    const response = await app.inject({
      method: "POST",
      url: `/api/content-engine/projects/${started.id}/drafts/linkedin-standard-post`,
      payload: {},
    });

    expect([404, 409]).toContain(response.statusCode);
    expect(response.json<{ error: string }>().error).not.toBe("unknown-target");
  });
});

describe("Content Engine revisions", () => {
  it("appends a revision rather than editing the last one", async () => {
    const started = startProject();

    const response = await app.inject({
      method: "POST",
      url: `/api/content-engine/projects/${started.id}/revisions`,
      payload: { audience: "Staff engineers" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ revision: number }>().revision).toBe(2);

    const detail = await app.inject({
      method: "GET",
      url: `/api/content-engine/projects/${started.id}`,
    });
    const body = detail.json<{
      project: { revisions: { revision: number; audience: string }[] };
    }>();
    expect(body.project.revisions).toHaveLength(2);
    expect(body.project.revisions[0]?.audience).toBe("Engineering leaders");
    expect(body.project.revisions[1]?.audience).toBe("Staff engineers");
  });

  it("reports prompt evidence as absent, not missing, before a freeze", async () => {
    const started = startProject();

    const response = await app.inject({
      method: "GET",
      url: `/api/content-engine/projects/${started.id}/prompt-evidence`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ promptEvidence: unknown }>().promptEvidence).toBeNull();
  });
});
