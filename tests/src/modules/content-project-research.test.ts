import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import type { AdapterDiagnostic, SourceItem } from "@chief-of-staff-demo/shared";
import { stubDraftGenerator, stubOutlineGenerator } from "./content-project-fixtures";
import { WorkspaceBrandProfileStore } from "../../../apps/server/src/brand-profile/store";
import {
  ContentProjectError,
  WorkspaceContentProjects,
} from "../../../apps/server/src/content-projects/projects";
import {
  PUBLIC_WEB_RESEARCH_PROVIDER_ID,
  createPublicSearchResearchProvider,
  type ResearchProvider,
  type ResearchProviderRequest,
  type ResearchProviderResult,
} from "../../../apps/server/src/content-projects/research";
import { ContentResearchStore } from "../../../apps/server/src/modules/content-research/store";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileResolver } from "../../../apps/server/src/person-profile/resolver";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";

const NOW = new Date("2026-08-31T18:00:00.000Z");

function publicItem(id: string): SourceItem {
  return fromPartial<SourceItem>({
    id,
    externalId: id,
    adapterId: "public-web",
    canonicalUrl: `https://evidence.example/${id}`,
    title: `Public evidence ${id}`,
    body: "Public material returned by an anonymous query.",
    discoveredAt: NOW.toISOString(),
  });
}

function diagnostic(patch: Partial<AdapterDiagnostic>): AdapterDiagnostic {
  return fromPartial<AdapterDiagnostic>({
    classification: "items_found",
    route: "https://search.example/search?q=redacted",
    status: 200,
    contentType: "text/html",
    parserStage: "fetch",
    responseHash: "hash",
    adapterVersion: "1",
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    retries: 0,
    affectedCapabilities: [],
    causeChain: [],
    ...patch,
  });
}

/** A finite research provider that records every bounded request it was given. */
function recordingProvider(
  id: string,
  respond: (
    request: ResearchProviderRequest,
  ) => ResearchProviderResult | Promise<ResearchProviderResult>,
): ResearchProvider & { requests: ResearchProviderRequest[] } {
  const requests: ResearchProviderRequest[] = [];
  return {
    id,
    version: "1",
    requests,
    async lookup(request) {
      requests.push(request);
      return respond(request);
    },
  };
}

function setup(researchProviders: ResearchProvider[]) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "content-project-research-"));
  const store = new PersonProfileStore(workspaceDir);
  const people = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });
  const owner = people.create({ fullName: "Workspace Owner", primaryEmail: "owner@example.com" });
  const ownerOnboarding = new OwnerOnboarding({ people, workspaceDir, now: () => NOW });
  ownerOnboarding.setConnectedIdentity("owner@example.com");
  ownerOnboarding.confirm(owner.id);
  const brandProfiles = new WorkspaceBrandProfileStore(workspaceDir, () => NOW);
  brandProfiles.accept({
    markdown: "# Brand Profile\n\n## Voice\nApproved Brand Voice.",
    sourceScan: {
      websiteUrl: "https://brand.example/",
      includedUrls: ["https://brand.example/"],
      excludedUrls: [],
    },
  });
  const projects = new WorkspaceContentProjects({
    workspaceDir,
    people,
    ownerOnboarding,
    brandProfiles,
    researchProviders,
    outlineGenerator: stubOutlineGenerator(),
    draftGenerator: stubDraftGenerator(),
    now: () => NOW,
  });
  projects.approveContentVoice(owner.id, "Approved Content Voice.");
  return { workspaceDir, store, people, owner, ownerOnboarding, brandProfiles, projects };
}

function topicProject(projects: WorkspaceContentProjects) {
  return projects.create({
    subject: { kind: "topic", topic: "How bounded research keeps evidence honest" },
    objective: "educate",
    audience: "Operators",
    constraints: [],
    targets: ["linkedin-standard-post"],
    researchMode: "fresh-bounded-research",
    seedMaterial: [],
  });
}

describe("Content Project Research Requests", () => {
  it("runs one finite Research Request with explicit scope, provider bundle, limits and diagnostics", async () => {
    const web = recordingProvider("public-web", () => ({
      items: [publicItem("web_1"), publicItem("web_2")],
      diagnostic: diagnostic({ classification: "items_found" }),
    }));
    const archive = recordingProvider("press-archive", () => ({
      items: [publicItem("archive_1")],
      diagnostic: diagnostic({ classification: "items_found", parserStage: "rss" }),
    }));
    const { projects } = setup([web, archive]);
    const project = topicProject(projects);

    const request = await projects.runResearchRequest(project.id, {
      question: "Which teams publish bounded research policies?",
      terms: ["bounded research policy"],
      bundle: { providerIds: ["public-web", "press-archive"], completeness: "best-effort" },
      limits: { maxQueriesPerProvider: 4, maxSourceItems: 10 },
    });

    expect(request).toMatchObject({
      projectId: project.id,
      projectRevision: 1,
      scope: {
        question: "Which teams publish bounded research policies?",
        terms: ["bounded research policy"],
        subject: { kind: "topic", topic: "How bounded research keeps evidence honest" },
      },
      bundle: { providerIds: ["public-web", "press-archive"], completeness: "best-effort" },
      limits: { maxQueriesPerProvider: 4, maxSourceItems: 10 },
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      completeness: "complete",
      identifierUses: [],
    });
    expect(request.id.startsWith("research_")).toBe(true);
    expect(request.sourceItems.map((item) => item.id)).toEqual(["web_1", "web_2", "archive_1"]);
    expect(request.providerOutcomes).toMatchObject([
      { providerId: "public-web", queries: 2, itemsFound: 2 },
      { providerId: "press-archive", queries: 2, itemsFound: 1 },
    ]);
    expect(request.providerOutcomes.map((outcome) => outcome.diagnostic.classification)).toEqual([
      "items_found",
      "items_found",
    ]);

    // Finite: each configured provider is asked exactly once and then the request ends.
    expect(web.requests).toHaveLength(1);
    expect(archive.requests).toHaveLength(1);
    expect(web.requests[0]?.queries).toEqual([
      "Which teams publish bounded research policies?",
      "bounded research policy",
    ]);

    const stored = projects.get(project.id)!.revisions[0];
    expect(stored.researchRequest?.id).toBe(request.id);
    expect(stored.evidenceReview?.sourceItems.map((item) => item.id)).toEqual([
      "web_1",
      "web_2",
      "archive_1",
    ]);
    expect(stored.evidenceReview?.diagnostics).toHaveLength(2);
  });

  it("sends every available identifier, email included, and records class, provider, time and purpose", async () => {
    const web = recordingProvider("public-web", () => ({
      items: [publicItem("web_1")],
      diagnostic: diagnostic({}),
    }));
    const { store, projects } = setup([web]);
    const subject = await new PersonProfileResolver({ store, sources: [], now: () => NOW }).resolve(
      {
        emails: ["grace@example.com"],
        fullNames: ["Grace Hopper"],
        handles: { x: ["gracehopper"] },
        profileUrls: ["https://linkedin.com/in/gracehopper"],
        employerHints: ["Compiler Works"],
      },
    );
    const project = projects.create({
      subject: { kind: "person-profile", profileId: subject.id },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "fresh-bounded-research",
      seedMaterial: [],
    });

    const request = await projects.runResearchRequest(project.id, {
      question: "compiler feedback",
      terms: [],
      bundle: { providerIds: ["public-web"], completeness: "best-effort" },
      limits: { maxQueriesPerProvider: 12, maxSourceItems: 5 },
    });

    expect(web.requests[0]?.queries).toEqual([
      "compiler feedback",
      '"grace@example.com"',
      '"Grace Hopper"',
      '"gracehopper"',
      '"https://linkedin.com/in/gracehopper"',
      '"Grace Hopper" "compiler works"',
      '"Grace Hopper" compiler feedback',
    ]);
    expect(request.identifierUses).toEqual([
      {
        identifierClass: "email",
        providerId: "public-web",
        usedAt: NOW.toISOString(),
        purpose: "person-identification",
      },
      {
        identifierClass: "full-name",
        providerId: "public-web",
        usedAt: NOW.toISOString(),
        purpose: "person-identification",
      },
      {
        identifierClass: "handle",
        providerId: "public-web",
        usedAt: NOW.toISOString(),
        purpose: "person-identification",
      },
      {
        identifierClass: "profile-url",
        providerId: "public-web",
        usedAt: NOW.toISOString(),
        purpose: "person-identification",
      },
      {
        identifierClass: "employer-hint",
        providerId: "public-web",
        usedAt: NOW.toISOString(),
        purpose: "person-identification",
      },
      {
        identifierClass: "full-name",
        providerId: "public-web",
        usedAt: NOW.toISOString(),
        purpose: "topic-evidence",
      },
    ]);
    expect(JSON.stringify(request.identifierUses)).not.toContain("grace@example.com");
  });

  it("keeps successful Source Items when another provider in the bundle fails", async () => {
    const web = recordingProvider("public-web", () => ({
      items: [publicItem("web_1")],
      diagnostic: diagnostic({ classification: "items_found" }),
    }));
    const archive = recordingProvider("press-archive", () => ({
      items: [publicItem("archive_1")],
      diagnostic: diagnostic({ classification: "blocked_access", status: 403 }),
    }));
    const { projects } = setup([web, archive]);
    const project = topicProject(projects);

    const request = await projects.runResearchRequest(project.id, {
      question: "bounded research policy",
      terms: [],
      bundle: { providerIds: ["public-web", "press-archive"], completeness: "best-effort" },
      limits: { maxQueriesPerProvider: 3, maxSourceItems: 10 },
    });

    expect(request.completeness).toBe("complete");
    expect(request.sourceItems.map((item) => item.id)).toEqual(["web_1"]);
    expect(request.providerOutcomes).toMatchObject([
      { providerId: "public-web", itemsFound: 1, diagnostic: { classification: "items_found" } },
      {
        providerId: "press-archive",
        itemsFound: 0,
        diagnostic: { classification: "blocked_access", status: 403 },
      },
    ]);
  });

  it("reports an explicitly selected all-provider bundle incomplete until every provider succeeds", async () => {
    const web = recordingProvider("public-web", () => ({
      items: [publicItem("web_1")],
      diagnostic: diagnostic({ classification: "items_found" }),
    }));
    let archiveFails = true;
    const archive = recordingProvider("press-archive", () => ({
      items: archiveFails ? [] : [publicItem("archive_1")],
      diagnostic: diagnostic({ classification: archiveFails ? "timeout" : "items_found" }),
    }));
    const { projects } = setup([web, archive]);
    const project = topicProject(projects);
    const bundle = {
      providerIds: ["public-web", "press-archive"],
      completeness: "all-providers" as const,
    };
    const limits = { maxQueriesPerProvider: 3, maxSourceItems: 10 };

    const incomplete = await projects.runResearchRequest(project.id, {
      question: "bounded research policy",
      terms: [],
      bundle,
      limits,
    });
    expect(incomplete.completeness).toBe("incomplete");
    expect(incomplete.sourceItems.map((item) => item.id)).toEqual(["web_1"]);

    archiveFails = false;
    const complete = await projects.runResearchRequest(project.id, {
      question: "bounded research policy",
      terms: [],
      bundle,
      limits,
    });
    expect(complete.completeness).toBe("complete");
    expect(complete.sourceItems.map((item) => item.id)).toEqual(["web_1", "archive_1"]);
    // The second finite request is a new Project revision, never a resumption of the first.
    expect(complete.projectRevision).toBe(2);
    expect(projects.get(project.id)!.revisions.map((entry) => entry.researchRequest?.id)).toEqual([
      incomplete.id,
      complete.id,
    ]);
  });

  it("turns a thrown provider into a classified failure instead of evidence", async () => {
    const archive = recordingProvider("press-archive", () => {
      throw new Error("the provider exploded");
    });
    const { projects } = setup([archive]);
    const project = topicProject(projects);

    const request = await projects.runResearchRequest(project.id, {
      question: "bounded research policy",
      terms: [],
      bundle: { providerIds: ["press-archive"], completeness: "all-providers" },
      limits: { maxQueriesPerProvider: 3, maxSourceItems: 10 },
    });

    expect(request.completeness).toBe("incomplete");
    expect(request.sourceItems).toEqual([]);
    expect(request.finishedAt).toBe(NOW.toISOString());
    expect(request.providerOutcomes[0]?.diagnostic).toMatchObject({
      classification: "internal_failure",
      parserStage: "adapter_boundary",
    });
    // An unknown origin stays unknown: an internal failure never claims the
    // public search seam's route for a provider that never used it.
    expect(request.providerOutcomes[0]?.diagnostic.route).toMatch(
      /^\[redacted-route;sha256:[0-9a-f]{64}\]$/,
    );
  });

  it("lets the owner include or exclude the actual returned evidence before freezing it", async () => {
    const web = recordingProvider("public-web", () => ({
      items: [publicItem("web_1"), publicItem("web_2"), publicItem("web_3")],
      diagnostic: diagnostic({}),
    }));
    const { projects } = setup([web]);
    const project = topicProject(projects);
    const request = await projects.runResearchRequest(project.id, {
      question: "bounded research policy",
      terms: [],
      bundle: { providerIds: ["public-web"], completeness: "best-effort" },
      limits: { maxQueriesPerProvider: 3, maxSourceItems: 10 },
    });

    const frozen = projects.freezeEvidence(project.id, {
      includedSourceItemIds: ["web_1", "web_3"],
      noExternalResearchAcknowledged: false,
    });

    expect(frozen.sourceItems).toEqual([
      request.sourceItems.find((item) => item.id === "web_1"),
      request.sourceItems.find((item) => item.id === "web_3"),
    ]);
    expect(() =>
      projects.freezeEvidence(project.id, {
        includedSourceItemIds: ["web_4"],
        noExternalResearchAcknowledged: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({ code: "invalid-evidence-selection" }),
    );
  });

  it("keeps private identifiers and search diagnostics out of the Content Engine prompt surface", async () => {
    const web = recordingProvider("public-web", () => ({
      items: [publicItem("web_1")],
      diagnostic: diagnostic({ route: "https://search.example/search?q=redacted" }),
    }));
    const { store, projects } = setup([web]);
    const subject = await new PersonProfileResolver({ store, sources: [], now: () => NOW }).resolve(
      {
        emails: ["grace@example.com"],
        fullNames: ["Grace Hopper"],
        handles: {},
        profileUrls: [],
        employerHints: [],
      },
    );
    const project = projects.create({
      subject: { kind: "person-profile", profileId: subject.id },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "fresh-bounded-research",
      seedMaterial: ["The owner already published on compiler feedback."],
    });
    await projects.runResearchRequest(project.id, {
      question: "compiler feedback",
      terms: [],
      bundle: { providerIds: ["public-web"], completeness: "best-effort" },
      limits: { maxQueriesPerProvider: 5, maxSourceItems: 10 },
    });
    expect(projects.promptEvidence(project.id)).toBe(null);

    projects.freezeEvidence(project.id, {
      includedSourceItemIds: ["web_1"],
      noExternalResearchAcknowledged: false,
    });

    const prompt = projects.promptEvidence(project.id)!;
    expect(Object.keys(prompt).sort()).toEqual([
      "brandVoice",
      "contentVoice",
      "profileProjections",
      "projectId",
      "projectRevision",
      "sourceItems",
      "userMaterial",
    ]);
    expect(prompt.sourceItems.map((item) => item.id)).toEqual(["web_1"]);
    /* The Source Item allowlist, pinned the same way the top-level shape is:
       a prompt sees what a writer works from, and none of the plumbing that
       says where the item came from or how complete it is. A field added to
       SourceItem lands here only when someone names it on purpose. */
    expect(Object.keys(prompt.sourceItems[0]).sort()).toEqual([
      "author",
      "body",
      "canonicalUrl",
      "description",
      "id",
      "publishedAt",
      "title",
      "transcript",
    ]);
    /* The owner's frozen record keeps the provenance the projection drops, so
       the narrowing is what the prompt sees rather than what was stored. */
    const frozenItem = projects.get(project.id)!.revisions[0].frozenEvidence!.sourceItems[0];
    expect(frozenItem.adapterId).toBe("public-web");
    for (const plumbing of ["adapterId", "externalId", "targetId", "discoveredAt"]) {
      expect(Object.keys(prompt.sourceItems[0])).not.toContain(plumbing);
    }
    expect(prompt.profileProjections.map((entry) => entry.role)).toEqual(["author", "subject"]);
    const serialized = JSON.stringify(prompt);
    expect(serialized).not.toContain("grace@example.com");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("search.example");
    expect(serialized).not.toContain("identifierClass");
    // The diagnostics themselves stay on the Project revision for the owner to read.
    expect(projects.get(project.id)!.revisions[0].frozenEvidence?.diagnostics).toHaveLength(1);
  });

  it("never creates a Content Research Named Person watch or any recurring residue", async () => {
    const web = recordingProvider("public-web", () => ({
      items: [publicItem("web_1")],
      diagnostic: diagnostic({}),
    }));
    const { store, projects, workspaceDir } = setup([web]);
    const subject = await new PersonProfileResolver({ store, sources: [], now: () => NOW }).resolve(
      {
        emails: ["grace@example.com"],
        fullNames: ["Grace Hopper"],
        handles: {},
        profileUrls: [],
        employerHints: [],
      },
    );
    const project = projects.create({
      subject: { kind: "person-profile", profileId: subject.id },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "fresh-bounded-research",
      seedMaterial: [],
    });

    await projects.runResearchRequest(project.id, {
      question: "compiler feedback",
      terms: [],
      bundle: { providerIds: ["public-web"], completeness: "best-effort" },
      limits: { maxQueriesPerProvider: 5, maxSourceItems: 10 },
    });

    const research = new ContentResearchStore(workspaceDir, () => NOW);
    expect(research.listAllPeople()).toEqual([]);
    expect(research.listSuggestions()).toEqual([]);
    expect(research.getBaseline(subject.id)).toBe(null);
    expect(research.getDailyCheckpoint()).toBe(null);
    expect(research.listItems()).toEqual([]);
    expect(existsSync(join(workspaceDir, "content-research"))).toBe(false);

    const persisted = readFileSync(join(workspaceDir, "content-engine", "projects.json"), "utf8");
    for (const recurringKey of [
      "checkpoint",
      "conditional",
      "baseline",
      "schedule",
      "lastSuccessfulAt",
      "namedPerson",
    ]) {
      expect(persisted).not.toContain(recurringKey);
    }
  });

  it("refuses a Research Request outside fresh bounded research, and an unconfigured bundle", async () => {
    const web = recordingProvider("public-web", () => ({
      items: [],
      diagnostic: diagnostic({ classification: "legitimate_empty" }),
    }));
    const { projects } = setup([web]);
    const project = projects.create({
      subject: { kind: "topic", topic: "Evidence the Workspace already holds" },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "existing-workspace-evidence",
      seedMaterial: [],
    });
    const request = {
      question: "bounded research policy",
      terms: [],
      bundle: { providerIds: ["public-web"], completeness: "best-effort" as const },
      limits: { maxQueriesPerProvider: 3, maxSourceItems: 10 },
    };

    await expect(projects.runResearchRequest(project.id, request)).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "research-request-blocked",
        missingGates: ["research-mode"],
      }),
    );
    expect(web.requests).toEqual([]);

    projects.reviseIntent(project.id, { researchMode: "fresh-bounded-research" });
    await expect(
      projects.runResearchRequest(project.id, {
        ...request,
        bundle: { providerIds: ["press-archive"], completeness: "best-effort" },
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({ code: "invalid-research-request" }),
    );
    await expect(
      projects.runResearchRequest(project.id, {
        ...request,
        limits: { maxQueriesPerProvider: 0, maxSourceItems: 10 },
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({ code: "invalid-research-request" }),
    );
    expect(web.requests).toEqual([]);
  });

  it("reuses the Workspace's shared public search seam as a finite research provider", async () => {
    const provider = createPublicSearchResearchProvider(
      async (query) => [
        {
          title: `Public page about ${query}`,
          url: `https://public.example/${encodeURIComponent(query)}`,
          snippet: "A public snippet.",
        },
      ],
      () => NOW,
    );
    const { projects } = setup([provider]);
    const project = topicProject(projects);

    const request = await projects.runResearchRequest(project.id, {
      question: "bounded research",
      terms: ["evidence review"],
      bundle: { providerIds: [PUBLIC_WEB_RESEARCH_PROVIDER_ID], completeness: "all-providers" },
      limits: { maxQueriesPerProvider: 2, maxSourceItems: 1 },
    });

    expect(request.completeness).toBe("complete");
    expect(request.providerOutcomes[0]).toMatchObject({
      providerId: PUBLIC_WEB_RESEARCH_PROVIDER_ID,
      queries: 2,
      itemsFound: 1,
      diagnostic: { classification: "items_found" },
    });
    expect(request.sourceItems).toHaveLength(1);
    expect(request.sourceItems[0]).toMatchObject({
      adapterId: PUBLIC_WEB_RESEARCH_PROVIDER_ID,
      canonicalUrl: "https://public.example/bounded%20research",
      title: "Public page about bounded research",
      description: "A public snippet.",
      body: null,
      discoveredAt: NOW.toISOString(),
      evidence: [
        { route: "https://public.example/bounded%20research", retrievedAt: NOW.toISOString() },
      ],
      completeness: { title: "available", description: "available", body: "unsupported" },
    });
  });

  it("keeps owner-attached evidence when a Research Request runs on the same revision", async () => {
    const web = recordingProvider("public-web", () => ({
      items: [publicItem("web_1")],
      diagnostic: diagnostic({}),
    }));
    const { projects } = setup([web]);
    const project = topicProject(projects);
    projects.attachEvidence(project.id, {
      sourceItems: [publicItem("owner_1")],
      diagnostics: [diagnostic({ route: "https://workspace.example/source" })],
    });

    const request = await projects.runResearchRequest(project.id, {
      question: "bounded research policy",
      terms: [],
      bundle: { providerIds: ["public-web"], completeness: "best-effort" },
      limits: { maxQueriesPerProvider: 3, maxSourceItems: 10 },
    });

    // The Research Request lands on a new revision; the owner's attachment is
    // left exactly as it was.
    expect(request.projectRevision).toBe(2);
    const revisions = projects.get(project.id)!.revisions;
    expect(revisions[0]?.evidenceReview?.sourceItems.map((item) => item.id)).toEqual(["owner_1"]);
    // The fresh revision reviews the attached Source Items alongside the
    // research results, so the owner can freeze both together.
    expect(revisions[1]?.researchRequest?.id).toBe(request.id);
    expect(revisions[1]?.evidenceReview?.sourceItems.map((item) => item.id)).toEqual([
      "owner_1",
      "web_1",
    ]);
    expect(revisions[1]?.evidenceReview?.diagnostics).toHaveLength(2);
    const frozen = projects.freezeEvidence(project.id, {
      includedSourceItemIds: ["owner_1", "web_1"],
      noExternalResearchAcknowledged: false,
    });
    expect(frozen.sourceItems.map((item) => item.id)).toEqual(["owner_1", "web_1"]);
  });

  it("refuses the Research Request when the revision leaves fresh bounded research mid-flight", async () => {
    let resumeProvider: () => void = () => {};
    const providerGate = new Promise<void>((resolve) => {
      resumeProvider = resolve;
    });
    const web = recordingProvider("public-web", async () => {
      await providerGate;
      return { items: [publicItem("web_1")], diagnostic: diagnostic({}) };
    });
    const { projects } = setup([web]);
    const project = topicProject(projects);

    const pending = projects
      .runResearchRequest(project.id, {
        question: "bounded research policy",
        terms: [],
        bundle: { providerIds: ["public-web"], completeness: "best-effort" },
        limits: { maxQueriesPerProvider: 3, maxSourceItems: 10 },
      })
      .catch((error: unknown) => error);
    // The owner revises the Project away from external research while the
    // providers are still in flight.
    projects.reviseIntent(project.id, { researchMode: "no-external-research" });
    resumeProvider();

    const outcome = await pending;
    expect(outcome).toBeInstanceOf(ContentProjectError);
    expect(outcome).toMatchObject({
      code: "research-request-blocked",
      missingGates: ["research-mode"],
    });
    const revision = projects.get(project.id)!.revisions.at(-1)!;
    expect(revision.researchMode).toBe("no-external-research");
    expect(revision.researchRequest).toBe(null);
    expect(revision.evidenceReview).toBe(null);
  });
});
