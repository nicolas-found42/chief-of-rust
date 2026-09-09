import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("automatic research retains a full page and publishes exact grounded work before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  const research = new PersonResearch({
    dossiers,
    search: async () => [
      { url: "https://example.com/maya", title: "Maya", snippet: "Short biography" },
    ],
    /* Only the discovered page exists. Continuous research also follows the
       work URL this extraction names, and a mock answering every URL with the
       same body would read the same document twice. */
    fetch: async (url) => ({
      url,
      status: url === "https://example.com/maya" ? 200 : 404,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body:
        url === "https://example.com/maya"
          ? "Contact maya@example.com. Maya designed the Atlas scheduler."
          : "",
    }),
    complete: async () => ({
      fullName: "Maya Chen",
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "scheduler",
          section: "work",
          statement: "Maya designed the Atlas scheduler.",
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote: "Maya designed the Atlas scheduler." }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [
        {
          id: "atlas",
          title: "Atlas",
          url: "https://example.com/atlas",
          kind: "system",
          startedAt: null,
          endedAt: null,
          claimIds: ["scheduler"],
          contribution: { text: "Designed the scheduler", claimIds: ["scheduler"] },
          teamContribution: null,
          authority: [],
          scale: [],
          constraints: [],
          outcomes: [],
        },
        { id: "unsupported", title: "Unsupported project", claimIds: [] },
      ],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  const outcome = await research.run(
    person,
    researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }),
  );
  /* One operation runs to its own completion rather than stopping on a pass
     boundary, and says so alongside its remaining gaps. */
  expect(outcome.state).toBe("current");
  expect(outcome.operation.conclusion).toBe("completed");
  expect(outcome.operation.gaps.join(" ")).toContain("does not mean every public fact");
  const dossier = dossiers.get(person.id)!;
  expect(dossier.works[0]?.contribution?.text).toBe("Designed the scheduler");
  const passage = dossier.claims[0].citations[0];
  expect(dossiers.source(person.id, passage.sourceId)?.text).toContain("Contact maya@example.com");
});

test("competing current role statements remain contested and do not silently replace the Profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-conflict-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com", role: "Engineer" });
  const dossiers = new PersonDossierStore(root);
  const text = (url: string) =>
    `maya@example.com holds the ${url.endsWith("one") ? "CTO" : "Director"} role.`;
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () =>
      ["one", "two"].map((path) => ({
        url: `https://example.com/${path}`,
        title: path,
        snippet: "",
      })),
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: text(url),
    }),
    complete: async (request) => {
      const url = (JSON.parse(request.user) as { document: { url: string } }).document.url;
      return {
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [
          {
            id: "role",
            section: "context",
            statement: text(url),
            fact: { field: "role", value: url.endsWith("one") ? "CTO" : "Director" },
            status: "supported",
            nature: "statement",
            matchConfidence: "high",
            effectiveFrom: "2024-01-01",
            effectiveTo: null,
            citations: [{ sourceId: "source", quote: text(url) }],
            supports: [],
            supersedes: [],
            changeReason: "Official role statement",
          },
        ],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  });
  await research.run(person, researchAllowance({ maxModelCalls: 6, maxMilliseconds: 10000 }));
  expect(dossiers.get(person.id)?.claims.map((c) => c.status)).toEqual(["contested", "contested"]);
  expect(people.get(person.id)?.role).toBe("Engineer");
});

test("confirmed Transcript evidence populates the owner's dossier without leaking into public projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-private-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya" });
  const dossiers = new PersonDossierStore(root);
  const quote = "Maya recommended pausing the confidential deployment.";
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [],
    privateDocuments: () => [
      {
        transcriptId: "meeting-private",
        text: quote,
        title: "Private meeting",
        active: () => true,
      },
    ],
    complete: async () => ({
      fullName: "Maya",
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "private",
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
    }),
  });
  await research.run(person, researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }));
  expect(dossiers.get(person.id)?.claims[0]?.statement).toContain("confidential deployment");
  expect(dossiers.project(person.id, "public")?.claims).toEqual([]);
  dossiers.removeTranscript("meeting-private");
  expect(dossiers.get(person.id)?.claims).toEqual([]);
});

test("research does not re-crawl a source the owner detached", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-rejected-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  const body = "Contact maya@example.com. Maya designed the Atlas scheduler.";
  const complete = async () => ({
    fullName: "Maya Chen",
    employer: null,
    sourceClass: "primary-artifact",
    author: null,
    publishedAt: null,
    claims: [
      {
        id: "scheduler",
        section: "work",
        statement: "Maya designed the Atlas scheduler.",
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: null,
        effectiveTo: null,
        citations: [{ sourceId: "source", quote: "Maya designed the Atlas scheduler." }],
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
  const result = { url: "https://example.com/maya", title: "Maya", snippet: "" };
  const research = new PersonResearch({
    dossiers,
    search: async () => [result],
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body,
    }),
    complete,
  });
  await research.run(person, researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }));
  const sourceId = dossiers.get(person.id)!.sourceIds[0];
  dossiers.detach(person.id, sourceId);
  people.forgetResearchSource(person.id, sourceId);

  const fetched: string[] = [];
  const next = new PersonResearch({
    dossiers,
    search: async () => [result],
    fetch: async (url) => {
      fetched.push(url);
      return {
        url,
        status: 200,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body,
      };
    },
    complete,
  });
  const outcome = await next.run(
    person,
    researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }),
  );
  expect(fetched).toEqual([]);
  expect(outcome.operation.leads).toContainEqual(
    expect.objectContaining({
      target: "https://example.com/maya",
      disposition: "rejected",
      reason: expect.stringContaining("rejected"),
    }),
  );
  expect(outcome.diagnostics).toContainEqual(
    expect.objectContaining({
      stage: "identity",
      code: "lead-rejected",
      target: "https://example.com/maya",
    }),
  );
  expect(outcome.state).not.toBe("unavailable");
});

test("a source rejected during a run is an attribution diagnostic rather than a failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-midrun-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  const body = "Contact maya@example.com. Maya designed the Atlas scheduler.";
  const result = { url: "https://example.com/maya", title: "Maya", snippet: "" };
  const complete = async () => ({
    fullName: null,
    employer: null,
    sourceClass: "primary-artifact",
    author: null,
    publishedAt: null,
    claims: [
      {
        id: "scheduler",
        section: "work",
        statement: "Maya designed the Atlas scheduler.",
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: null,
        effectiveTo: null,
        citations: [{ sourceId: "source", quote: "Maya designed the Atlas scheduler." }],
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
  const fetchResponse = (url: string) => ({
    url,
    status: 200,
    contentType: "text/plain",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
  });
  const research = new PersonResearch({
    dossiers,
    search: async () => [result],
    fetch: async (url) => fetchResponse(url),
    complete,
  });
  await research.run(person, researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }));
  const sourceId = dossiers.get(person.id)!.sourceIds[0];

  const midrun = new PersonResearch({
    dossiers,
    search: async () => [result],
    fetch: async (url) => {
      dossiers.detach(person.id, sourceId);
      people.forgetResearchSource(person.id, sourceId);
      return fetchResponse(url);
    },
    complete,
  });
  const outcome = await midrun.run(
    person,
    researchAllowance({ maxModelCalls: 6, maxMilliseconds: 10000 }),
  );
  /* The owner's decision landing mid-run stops attribution: that is an
     interruption of this operation, not a completed empty one. */
  expect(outcome.state).toBe("interrupted");
  expect(outcome.operation.interruption?.code).toBe("lifecycle-invalidated");
  expect(outcome.operation.detail).toContain("rejected a source");
});

test("retains an anchored retrieved source when extraction fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-retained-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  const research = new PersonResearch({
    dossiers,
    search: async () => [{ url: "https://example.com/maya", title: "Maya", snippet: "" }],
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: "maya@example.com built Atlas.",
    }),
    complete: async () => {
      throw new Error("model unavailable");
    },
  });
  await research.run(person, researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }));
  const dossier = dossiers.get(person.id);
  expect(dossier?.sourceIds).toHaveLength(1);
  expect(dossier?.claims).toHaveLength(0);
  expect(dossiers.source(person.id, dossier!.sourceIds[0])?.text).toBe(
    "maya@example.com built Atlas.",
  );
});

test("source revisions keep one work identity and dated current facts supersede older open-ended claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-version-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  let year = "2024";
  const quote = () =>
    `maya@example.com is ${year === "2024" ? "Engineer" : "CTO"} and built Atlas.`;
  const research = new PersonResearch({
    dossiers,
    search: async () => [{ url: "https://example.com/maya", title: "Maya", snippet: "" }],
    fetch: async (url) => ({
      url,
      status: url === "https://example.com/maya" ? 200 : 404,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: url === "https://example.com/maya" ? quote() : "",
    }),
    complete: async () => ({
      fullName: null,
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "role",
          section: "career",
          statement: quote(),
          fact: { field: "role", value: year === "2024" ? "Engineer" : "CTO" },
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: `${year}-01-01`,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote: quote() }],
          supports: [],
          supersedes: [],
          changeReason: "Official appointment effective on the stated date.",
        },
      ],
      works: [
        {
          id: "atlas",
          title: "Atlas",
          url: "https://example.com/atlas",
          kind: "system",
          startedAt: null,
          endedAt: null,
          claimIds: ["role"],
          contribution: { text: "Built Atlas", claimIds: ["role"] },
          teamContribution: null,
          authority: [],
          scale: [],
          constraints: [],
          outcomes: [],
        },
      ],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  const allowance = researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 });
  await research.run(person, allowance);
  const first = dossiers.get(person.id)!;
  year = "2025";
  await research.run(person, allowance);
  const current = dossiers.get(person.id)!;
  expect(current.works).toHaveLength(1);
  expect(current.works[0].id).toBe(first.works[0].id);
  expect(current.works[0].claimIds).toHaveLength(2);
  expect(current.claims.find((claim) => claim.fact?.value === "Engineer")).toMatchObject({
    status: "superseded",
    effectiveTo: "2025-01-01",
  });
  expect(current.claims.find((claim) => claim.fact?.value === "CTO")?.supersedes).toContain(
    first.claims[0].id,
  );
  expect(dossiers.getRevision(person.id, first.revision)?.claims[0].status).toBe("supported");
});

test("a lead trailing the read batch beyond the selection margin is decided, not carried as pending work", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-registration-"));
  roots.push(root);
  const dossiers = new PersonDossierStore(root);
  const urls = Array.from({ length: 12 }, (_, index) => `https://example.com/page-${index}`);
  const research = new PersonResearch({
    dossiers,
    search: async () =>
      urls.map((url, rank) => ({
        url,
        title: rank < 2 ? "maya@example.com designed the Atlas scheduler." : "Unrelated listing",
        snippet: rank < 2 ? "Contact maya@example.com." : "",
      })),
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: "Contact maya@example.com. Maya designed the Atlas scheduler.",
    }),
    complete: async () => ({
      fullName: "Maya Chen",
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "scheduler",
          section: "work",
          statement: "Maya designed the Atlas scheduler.",
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote: "Maya designed the Atlas scheduler." }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const outcome = await research.run(
    person,
    researchAllowance({ maxModelCalls: 2, maxMilliseconds: 20000, readConcurrency: 1 }),
  );
  /* The bundle answered twelve deep. The head is read; the tail — everything
     the operation's own ranking scores more than the selection margin below
     the batch — is decided as surpassed rather than carried as work the
     allowance can never reach, so unresolved leads stop dominating the
     record (#239). */
  const urlLeads = outcome.operation.leads.filter((lead) => lead.kind === "url");
  expect(urlLeads).toHaveLength(12);
  const rejected = urlLeads.filter((lead) => lead.disposition === "rejected");
  expect(rejected).toHaveLength(10);
  for (const lead of rejected) expect(lead.reason).toMatch(/selection margin/);
  const investigated = urlLeads.filter((lead) =>
    ["investigated", "deduplicated"].includes(lead.disposition),
  );
  expect(investigated.map((lead) => lead.target)).toEqual([
    "https://example.com/page-0",
    "https://example.com/page-1",
  ]);
  expect(urlLeads.filter((lead) => lead.disposition === "interrupted")).toHaveLength(0);
});

test("a lead selection keeps passing over is decided, and the planner is not asked while the batch is already full", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-backlog-"));
  roots.push(root);
  const dossiers = new PersonDossierStore(root);
  const slug = (query: string) =>
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 16);
  let plannerCalls = 0;
  const planRounds: number[] = [];
  const research = new PersonResearch({
    dossiers,
    search: async (query) =>
      [0, 1, 2, 3].map((index) => ({
        url: `https://${slug(query)}.example.com/page-${index}`,
        title: query,
        snippet:
          index < 2
            ? "maya@example.com Maya Chen designed the Atlas scheduler."
            : "Maya Chen listing",
      })),
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: "Contact maya@example.com. Maya designed the Atlas scheduler.",
    }),
    plan: async (request) => {
      plannerCalls += 1;
      /* The round is embedded by planNextLeads in this same process; the
         payload shape is the planner's own request contract. */
      const payload = JSON.parse(request.user) as { round: number };
      planRounds.push(payload.round);
      return {
        queries: [`"Maya Chen" planning round ${String(plannerCalls)}`],
        urls: [
          {
            url: `https://planner-${String(plannerCalls)}.example.com/maya`,
            why: "A specific page worth reading",
          },
        ],
        targetCoverage: ["spoken-evidence"],
        remainingQuestions: [],
      };
    },
    complete: async () => ({
      fullName: "Maya Chen",
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "scheduler",
          section: "work",
          statement: "Maya designed the Atlas scheduler.",
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote: "Maya designed the Atlas scheduler." }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
  const outcome = await research.run(
    person,
    researchAllowance({ maxModelCalls: 30, maxMilliseconds: 30000, readConcurrency: 1 }),
  );
  const urlLeads = outcome.operation.leads.filter((lead) => lead.kind === "url");
  const rejected = urlLeads.filter((lead) => lead.disposition === "rejected");
  const retired = rejected.filter((lead) => /selection margin/.test(lead.reason));
  const interrupted = urlLeads.filter((lead) => lead.disposition === "interrupted");
  /* Unresolved leads are no longer the dominant outcome: the backlog the
     operation never got to is decided as surpassed, with the score and the
     batch floor in the reason (#239). */
  expect(retired.length).toBeGreaterThan(0);
  expect(interrupted.length).toBeLessThan(rejected.length);
  /* The throttle keeps the planner rare while the backlog is deep: without it
     this scenario's unsatisfied areas would buy a call every round, so a
     handful of calls over a run this long is the throttled contract, and the
     first call cannot land on round 1 where the pool already filled the
     batch (#239). */
  expect(plannerCalls).toBeLessThanOrEqual(4);
  expect(planRounds.every((round) => round >= 2)).toBe(true);
});

test("a long document is extracted in bounded parts that combine into one source", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-parts-"));
  roots.push(root);
  const dossiers = new PersonDossierStore(root);
  const body = "Contact maya@example.com.\n\nMaya designed the Atlas scheduler.\n\n".repeat(500);
  const seenParts: string[] = [];
  const research = new PersonResearch({
    dossiers,
    search: async (query) =>
      query.includes("maya")
        ? [{ url: "https://example.com/maya", title: "Maya", snippet: "biography" }]
        : [],
    fetch: async (url) => ({
      url,
      status: url === "https://example.com/maya" ? 200 : 404,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: url === "https://example.com/maya" ? body : "",
    }),
    complete: async (request) => {
      const document = (JSON.parse(request.user) as { document: { part: string } }).document;
      seenParts.push(document.part);
      return {
        fullName: "Maya Chen",
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [
          {
            id: `claim-${document.part.replace("/", "-")}`,
            section: "work",
            statement: `Part ${document.part} states Maya designed the Atlas scheduler.`,
            status: "supported",
            nature: "statement",
            matchConfidence: "high",
            effectiveFrom: null,
            effectiveTo: null,
            citations: [{ sourceId: "source", quote: "Maya designed the Atlas scheduler." }],
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
  });
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const outcome = await research.run(person, researchAllowance({ maxModelCalls: 8 }));
  /* Each part is its own call, named as its part of the document. */
  expect(seenParts).toEqual(["1/2", "2/2"]);
  /* The parts combine into one source: per-part ids never collide, and both
     parts' claims are attributed to the single retained document. */
  const dossier = dossiers.get(person.id)!;
  const citationSourceIds = new Set(
    dossier.claims.flatMap((claim) => claim.citations.map((citation) => citation.sourceId)),
  );
  expect(citationSourceIds).toHaveLength(1);
  expect(dossiers.source(person.id, [...citationSourceIds][0])?.text).toBe(body);
  expect(dossier.claims).toHaveLength(2);
  expect(new Set(dossier.claims.map((claim) => claim.id))).toHaveLength(2);
  for (const claim of dossier.claims) expect(claim.statement).toMatch(/^Part \d\/2 states/);
  expect(outcome.operation.conclusion).toBe("completed");
  /* The durable per-call record: one metrics row per part, carrying the
     measured size and duration of that call. */
  const metrics = outcome.operation.attempts.filter(
    (attempt) => attempt.code === "model-call-metrics",
  );
  expect(metrics).toHaveLength(2);
  for (const record of metrics) {
    expect(record.observed?.modelCallDurationMilliseconds).toBeGreaterThanOrEqual(0);
    expect(record.observed?.modelInputCharacters).toBeGreaterThan(0);
    expect(record.observed?.modelOutputCharacters).toBeGreaterThan(0);
  }
});

test("a part that fails at the model boundary fails the document and keeps the lead retryable", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-part-failure-"));
  roots.push(root);
  const dossiers = new PersonDossierStore(root);
  const body = "Contact maya@example.com.\n\nMaya designed the Atlas scheduler.\n\n".repeat(500);
  const research = new PersonResearch({
    dossiers,
    search: async (query) =>
      query.includes("maya")
        ? [{ url: "https://example.com/maya", title: "Maya", snippet: "biography" }]
        : [],
    fetch: async (url) => ({
      url,
      status: url === "https://example.com/maya" ? 200 : 404,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: url === "https://example.com/maya" ? body : "",
    }),
    complete: async (request) => {
      if (JSON.parse(request.user).document.part === "2/2")
        throw new Error("The model provider failed mid-document.");
      return {
        fullName: "Maya Chen",
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  });
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const outcome = await research.run(person, researchAllowance({ maxModelCalls: 8 }));
  /* No partial document is published: the lead stays retryable, and the
     failure is a per-document strike, not a provider verdict. */
  const urlLead = outcome.operation.leads.find((lead) => lead.kind === "url")!;
  expect(urlLead.disposition).toBe("interrupted");
  expect(dossiers.get(person.id)?.claims ?? []).toHaveLength(0);
  expect(outcome.operation.conclusion).not.toBe("interrupted");
});
