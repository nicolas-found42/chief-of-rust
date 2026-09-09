import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composePersonProfiles,
  type ConfirmedTranscript,
  type PersonProfilesComposition,
  type PersonProfilesCompositionDeps,
} from "../../../apps/server/src/person-profile/composition";
import { modelBoundaryFailure } from "../../../apps/server/src/llm/failure";
import { PublicSearchUnavailableError } from "../../../apps/server/src/source-adapters/search";
import { PersonResearchStatusSchema } from "@chief-of-staff-demo/shared";

/**
 * The Person Profiles product, composed without a Shell.
 *
 * Every question below used to be answerable only by composing the whole
 * application: the research queue's evidence revision, the upcoming-meeting
 * enqueue, the confirmed Transcripts research is allowed to read, and the two
 * transcript-deletion registries were all closures written inline in
 * `composeShell`. They are this module's own now, so they are reachable from a
 * test that builds one product over one temporary Workspace.
 */

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  root: string;
  people: PersonProfilesComposition;
  /** What the Catalog would answer, under this test's control. */
  evidence: Map<string, ConfirmedTranscript[]>;
  upcoming: string[];
  enabled: { value: boolean };
}

function compose(overrides: Partial<PersonProfilesCompositionDeps> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "person-profiles-composition-"));
  roots.push(root);
  const evidence = new Map<string, ConfirmedTranscript[]>();
  const upcoming: string[] = [];
  const enabled = { value: true };
  const people = composePersonProfiles({
    workspaceDir: root,
    search: async () => [],
    /* A schema-valid empty extraction: a shape-invalid answer is a retryable
       part failure under ADR-0074, so the default mock must answer the
       dossier schema, not merely resemble it. */
    complete: () => async () => ({
      fullName: null,
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
    confirmedTranscripts: (profileId) => evidence.get(profileId) ?? [],
    transcriptStillConfirmed: (profileId, transcriptId, checksum) =>
      (evidence.get(profileId) ?? []).some(
        (entry) => entry.transcriptId === transcriptId && entry.checksum === checksum,
      ),
    researchEnabled: () => enabled.value,
    upcomingParticipantEmails: () => upcoming,
    ...overrides,
  });
  return { root, people, evidence, upcoming, enabled };
}

/** One supported claim from one read document: what extraction returns. */
function extractedClaim(quote: string) {
  return {
    fullName: null,
    employer: null,
    sourceClass: "primary-artifact",
    author: null,
    publishedAt: null,
    claims: [
      {
        id: "work",
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
}

describe("the Person Profiles composition", () => {
  it("keeps a shutdown interruption observable alongside its retained source", async () => {
    let release!: (value: unknown) => void;
    let extracting!: () => void;
    const started = new Promise<void>((resolve) => {
      extracting = resolve;
    });
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: "Maya Chen built Atlas.",
        }),
      },
      complete: () => () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
          extracting();
        }),
    });
    const profile = h.people.research.startFor({
      fullName: "Maya Chen",
      profileUrls: ["https://example.com/maya"],
    });
    const pending = h.people.research.runNow(profile.id);
    await started;
    h.people.stop();
    release({});
    await pending;
    expect(h.people.research.outcome(profile.id)?.conclusion).toBe("interrupted");
    expect(h.people.queue.status().jobs.find((job) => job.profileId === profile.id)?.state).toBe(
      "interrupted",
    );
    expect(h.people.research.sources(profile.id)).toContainEqual(
      expect.objectContaining({ text: "Maya Chen built Atlas." }),
    );
  });

  it("preserves a long Retry-After and stops recovery rather than retrying early", async () => {
    vi.useFakeTimers();
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 429,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: "3600",
          body: "Rate limited",
        }),
      },
    });
    const profile = h.people.research.startFor({
      fullName: "Maya Chen",
      profileUrls: ["https://example.com/maya"],
    });
    const pending = h.people.research.runNow(profile.id);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(true);
    const outcome = await pending;
    expect(outcome?.attempts).toContainEqual(
      expect.objectContaining({
        code: "rate-limited",
        recovery: "stopped",
        observed: expect.objectContaining({ retryAfterMilliseconds: 3_600_000 }),
        recoveryStopped: expect.stringContaining("Retry-After"),
      }),
    );
  });

  it("redacts credential-bearing URLs from failure explanations, echoed response excerpts and remediation", async () => {
    const url = "https://example.com/maya?token=private-token-value";
    const h = compose({
      researchTestPorts: {
        fetch: async (target) => ({
          url: target,
          status: 403,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: `Forbidden request: ${target}`,
        }),
      },
    });
    const profile = h.people.research.startFor({ fullName: "Maya Chen", profileUrls: [url] });
    const outcome = await h.people.research.runNow(profile.id);
    expect(outcome?.attempts.some((attempt) => attempt.outcome === "failed")).toBe(true);
    expect(
      outcome?.attempts.find((attempt) => attempt.stage === "access")?.observed?.excerpt,
    ).toContain("Forbidden request: https://example.com/maya");
    expect(JSON.stringify(outcome?.attempts)).not.toContain("private-token-value");
  });

  it("reports model-provider failure as interrupted while preserving the retrieved evidence", async () => {
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: "Maya built Atlas.",
        }),
      },
      complete: () => async () => {
        throw new Error("Provider unavailable");
      },
    });
    const profile = h.people.profiles.create({ profileUrls: ["https://example.com/maya"] });
    await h.people.queue.tick();
    expect(h.people.queue.status().jobs[0]?.state).toBe("interrupted");
    const dossier = h.people.dossiers.get(profile.id)!;
    expect(h.people.dossiers.source(profile.id, dossier.sourceIds[0])?.text).toBe(
      "Maya built Atlas.",
    );
    expect(dossier.claims).toEqual([]);
  });
  /**
   * The diagnosed extraction stall is a stream that opens a tool call and
   * then buffers it: the silent ceiling fires `request_timeout` naming the
   * route, while the document itself is fine (#232). Extraction asks routing
   * for a fast route up front, and the operation completes once an answer
   * arrives instead of interrupting on the stall (#233).
   */
  it("asks routing for a fast route and completes after a stalled extraction attempt", async () => {
    const floors: unknown[] = [];
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: `Maya built project ${new URL(url).pathname.slice(1)}.`,
        }),
      },
      complete: () => async (request) => {
        /* `preferredMinThroughput` does not exist pre-fix; the cast keeps this
           red at runtime rather than uncompilable while the fix is absent. */
        floors.push((request as unknown as Record<string, unknown>).preferredMinThroughput);
        const { document } = JSON.parse(request.user) as { document: { url: string } };
        const index = new URL(document.url).pathname.slice(1);
        if (index === "1") {
          throw modelBoundaryFailure({
            call: { provider: "openrouter", model: "test/model", binding: "forced_tool_call" },
            classification: "request_timeout",
            timeoutMs: 90_000,
            upstreamServer: "Wafer",
          });
        }
        const quote = `Maya built project ${index}.`;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [
            {
              id: `work-${index}`,
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
    });
    const profile = h.people.profiles.create({
      profileUrls: ["https://example.com/1", "https://example.com/2"],
    });
    await h.people.queue.tick();
    const outcome = h.people.research.outcome(profile.id)!;
    /* The stall is absorbed and the surviving document still yields its claim. */
    expect(outcome.conclusion).toBe("completed");
    expect(h.people.dossiers.get(profile.id)!.claims.map((claim) => claim.statement)).toEqual([
      "Maya built project 2.",
    ]);
    /* Every extraction attempt asked routing for a fast route. */
    expect(floors).toEqual([50, 50]);
    /* And the research record names the preference, so a later comparison
       stays attributable instead of silently faster. */
    expect(outcome.attempts).toContainEqual(
      expect.objectContaining({
        stage: "extraction",
        code: "model-boundary-failed",
        configuration: expect.objectContaining({ preferredMinThroughput: "50 tokens/second" }),
      }),
    );
  });

  it("records the routing and reasoning each extraction attempt was sent with", async () => {
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: `Maya built project ${new URL(url).pathname.slice(1)}.`,
        }),
      },
      complete: () => async (request) => {
        request.retry?.onAttempt({
          attempt: 1,
          binding: "forced_tool_call",
          provider: "openrouter",
          model: "test/model",
          outcome: "succeeded",
          diagnostic: null,
          delayMs: 0,
          stoppedReason: null,
          providerIgnore: ["Groq"],
          reasoningEffort: "low",
        });
        const { document } = JSON.parse(request.user) as { document: { url: string } };
        const quote = `Maya built project ${new URL(document.url).pathname.slice(1)}.`;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [
            {
              id: "work-1",
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
    });
    const profile = h.people.profiles.create({ profileUrls: ["https://example.com/1"] });
    await h.people.queue.tick();
    const outcome = h.people.research.outcome(profile.id)!;
    expect(outcome.conclusion).toBe("completed");
    /* The attempt record carries what the wire attempt was sent with, so a
       rest firing mid-assessment — or a thinking budget resolving per model —
       stays attributable in a later comparison instead of a silent confound. */
    expect(outcome.attempts).toContainEqual(
      expect.objectContaining({
        stage: "extraction",
        code: "model-response-received",
        configuration: expect.objectContaining({
          providerIgnore: "Groq",
          reasoningEffort: "low",
        }),
      }),
    );
  });

  /**
   * One document that stalls the configured model is not the same observation
   * as a provider that is down. The operation kept a sixty-call budget and
   * spent one of it before #228's live runs stopped twenty of thirty people at
   * their first extraction; the spec asks for temporary failures to be retried
   * and other work to continue.
   */
  it("continues with the remaining sources after a transient extraction failure", async () => {
    const failed: string[] = [];
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: `Maya built project ${new URL(url).pathname.slice(1)}.`,
        }),
      },
      complete: () => async (request) => {
        const { document } = JSON.parse(request.user) as { document: { url: string } };
        const index = new URL(document.url).pathname.slice(1);
        if (index === "1") {
          failed.push(index);
          throw new Error("Provider stalled mid-stream");
        }
        const quote = `Maya built project ${index}.`;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [
            {
              id: `work-${index}`,
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
    });
    const profile = h.people.profiles.create({
      profileUrls: ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
    });
    await h.people.queue.tick();
    const outcome = h.people.research.outcome(profile.id)!;
    expect(failed).toEqual(["1"]);
    expect(outcome.conclusion).toBe("completed");
    expect(
      h.people.dossiers
        .get(profile.id)!
        .claims.map((claim) => claim.statement)
        .sort(),
    ).toEqual(["Maya built project 2.", "Maya built project 3."]);
    /* The failure stays observable: continuing is not the same as hiding it. */
    expect(outcome.attempts).toContainEqual(
      expect.objectContaining({
        stage: "extraction",
        code: "model-boundary-failed",
        target: "https://example.com/1",
      }),
    );
    /* And the document stays retryable: the model failed, the page did not. */
    expect(outcome.leads.find((lead) => lead.target === "https://example.com/1")?.disposition).toBe(
      "interrupted",
    );
  });

  /**
   * A provider that keeps failing is still an interruption, and the operation
   * stops paying for it rather than spending its whole budget on a dead seam.
   */
  it("interrupts research once the model provider fails persistently during extraction", async () => {
    let calls = 0;
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: `Maya built project ${new URL(url).pathname.slice(1)}.`,
        }),
      },
      complete: () => async () => {
        calls += 1;
        throw new Error("Provider unavailable");
      },
    });
    const profile = h.people.profiles.create({
      profileUrls: [
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
        "https://example.com/4",
        "https://example.com/5",
      ],
    });
    await h.people.queue.tick();
    const outcome = h.people.research.outcome(profile.id)!;
    expect(outcome.conclusion).toBe("interrupted");
    expect(outcome.interruption?.code).toBe("model-boundary-failed");
    /* Tolerance is bounded: five readable documents did not buy five failures. */
    expect(calls).toBeLessThan(5);
  });

  /**
   * Tolerance counts a run of failures, not a lifetime total. A provider that
   * stalls on one awkward document, answers the next, and stalls again is
   * still working; spending the operation's leads on it is the point.
   */
  it("resets the boundary-failure tolerance after an extraction succeeds", async () => {
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: `Maya built project ${new URL(url).pathname.slice(1)}.`,
        }),
      },
      complete: () => async (request) => {
        const { document } = JSON.parse(request.user) as { document: { url: string } };
        const index = new URL(document.url).pathname.slice(1);
        /* Fail, succeed, fail, succeed, fail: never three in a row. */
        if (Number(index) % 2 === 1) throw new Error("Provider stalled mid-stream");
        const quote = `Maya built project ${index}.`;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [
            {
              id: `work-${index}`,
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
    });
    const profile = h.people.profiles.create({
      profileUrls: [1, 2, 3, 4, 5].map((index) => `https://example.com/${index}`),
    });
    await h.people.queue.tick();
    const outcome = h.people.research.outcome(profile.id)!;
    expect(outcome.conclusion).toBe("completed");
    expect(
      h.people.dossiers
        .get(profile.id)!
        .claims.map((claim) => claim.statement)
        .sort(),
    ).toEqual(["Maya built project 2.", "Maya built project 4."]);
    /* Three failures happened; none of them followed another one. */
    expect(
      outcome.attempts.filter(
        (attempt) => attempt.stage === "extraction" && attempt.code === "model-boundary-failed",
      ),
    ).toHaveLength(3);
  });

  /**
   * With no success to reset against, every failure the operation saw was the
   * provider's. Reporting that as a completed operation with no evidence would
   * claim the person has no public record.
   */
  it("interrupts an operation that never completed one extraction, short of the tolerance", async () => {
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: "Maya built the thing.",
        }),
      },
      complete: () => async () => {
        throw new Error("Provider unavailable");
      },
    });
    const profile = h.people.profiles.create({
      profileUrls: ["https://example.com/1", "https://example.com/2"],
    });
    await h.people.queue.tick();
    const outcome = h.people.research.outcome(profile.id)!;
    expect(outcome.conclusion).toBe("interrupted");
    expect(outcome.interruption?.code).toBe("model-boundary-failed");
    expect(h.people.dossiers.get(profile.id)!.claims).toEqual([]);
  });

  it("recovers a temporary retrieval failure in the same operation and retains its observed cause", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const url = "https://example.com/";
    const h = compose({
      researchTestPorts: {
        fetch: async () => {
          attempts += 1;
          if (attempts === 2) throw new Error("Connection reset");
          return {
            url,
            status: attempts === 1 ? 503 : 200,
            contentType: "text/plain",
            etag: null,
            lastModified: null,
            retryAfter: "21",
            body: attempts === 1 ? "Temporarily unavailable" : "Maya built Atlas.",
          };
        },
      },
      complete: () => async () => ({
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      }),
    });
    const profile = h.people.profiles.create({ profileUrls: [url] });
    const pending = h.people.queue.tick();
    /* The source asked for 21 seconds; the wait is honoured rather than
       rejected, so nothing is retained while it is still running. */
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.people.dossiers.get(profile.id)).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    /* The second attempt throws, and its own backoff runs before the third. */
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    const dossier = h.people.dossiers.get(profile.id)!;
    expect(
      dossier.sourceIds.some(
        (id) => h.people.dossiers.source(profile.id, id)?.text === "Maya built Atlas.",
      ),
    ).toBe(true);
    expect(h.people.queue.status().jobs[0]?.diagnostics).toContainEqual(
      expect.objectContaining({
        stage: "transport",
        code: "http-error",
        attempt: 1,
        recovery: "retry",
        target: url,
        observed: expect.objectContaining({ status: 503, retryAfterMilliseconds: 21000 }),
      }),
    );
    /* The compact view is a slice; the operation record keeps the whole
       history, so the recovery can still be traced back to what failed. */
    const history = h.people.queue.status().jobs[0].operation!.attempts;
    const failed = history.find((entry) => entry.observed?.status === 503)!;
    expect(failed.attemptOf).toBeTruthy();
    expect(history).toContainEqual(
      expect.objectContaining({
        attemptOf: failed.attemptOf,
        attempt: 3,
        code: "retrieval-recovered",
        recovery: "recovered",
      }),
    );
    expect(history).toContainEqual(
      expect.objectContaining({
        attemptOf: failed.attemptOf,
        attempt: 2,
        code: "transport-failed",
        recovery: "retry",
        cause: "unknown",
      }),
    );
  });

  it("follows attributed work beyond old batch and allowance limits in one operation", async () => {
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => {
          const index = Number(new URL(url).pathname.slice(1));
          return {
            url,
            status: 200,
            contentType: "text/html",
            etag: null,
            lastModified: null,
            retryAfter: null,
            body: `<article><p>Maya built project ${index}.</p>${index < 6 ? `<a href="https://example.com/${index + 1}">Next project</a>` : ""}</article>`,
          };
        },
      },
      complete: () => async (request) => {
        const { document } = JSON.parse(request.user) as { document: { url: string } };
        const index = Number(new URL(document.url).pathname.slice(1));
        const quote = `Maya built project ${index}.`;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [
            {
              id: "work",
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
          works:
            index < 6
              ? [
                  {
                    id: "next",
                    title: "Next project",
                    url: `https://example.com/${index + 1}`,
                    kind: "system",
                    startedAt: null,
                    endedAt: null,
                    claimIds: ["work"],
                    contribution: { text: quote, claimIds: ["work"] },
                    teamContribution: null,
                    authority: [],
                    scale: [],
                    constraints: [],
                    outcomes: [],
                  },
                ]
              : [],
          expertise: [],
          connections: [],
          sections: [],
        };
      },
    });
    /* The default operation allowance comfortably covers this chain; the
       bounded-ceiling behavior under a tiny allowance is asserted by the
       safety-bound test below, which needs profileCalls: 1 to stay bounded. */
    const profile = h.people.profiles.create({ profileUrls: ["https://example.com/1"] });
    await h.people.queue.tick();
    expect(h.people.dossiers.get(profile.id)?.claims.map((claim) => claim.statement)).toContain(
      "Maya built project 6.",
    );
    const job = h.people.queue.status().jobs[0];
    expect(job.state).toBe("current");
    expect(job.operation?.conclusion).toBe("completed");
  });

  it("reports a reached safety bound as incomplete with its unread lead retained", async () => {
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => {
          const index = Number(new URL(url).pathname.slice(1));
          return {
            url,
            status: 200,
            contentType: "text/html",
            etag: null,
            lastModified: null,
            retryAfter: null,
            body: `<article><p>Maya built project ${index}.</p><a href="https://example.com/${index + 1}">Next project</a></article>`,
          };
        },
      },
      complete: () => async (request) => {
        const { document } = JSON.parse(request.user) as { document: { url: string } };
        const index = Number(new URL(document.url).pathname.slice(1));
        const quote = `Maya built project ${index}.`;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [
            {
              id: "work",
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
          works: [
            {
              id: "next",
              title: "Next project",
              url: `https://example.com/${index + 1}`,
              kind: "system",
              startedAt: null,
              endedAt: null,
              claimIds: ["work"],
              contribution: { text: quote, claimIds: ["work"] },
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
        };
      },
    });
    /* One model call is a safety bound, not a definition of completion: the
       operation stops, says so, and keeps the lead it never got to. */
    h.people.queue.configure({ profileCalls: 1 });
    h.people.profiles.create({ profileUrls: ["https://example.com/1"] });
    await h.people.queue.tick();

    const job = h.people.queue.status().jobs[0];
    expect(job.state).toBe("incomplete");
    expect(job.operation?.conclusion).toBe("bounded");
    expect(job.detail).toContain("ceiling");
    expect(
      job.operation?.leads.filter((lead) => lead.disposition === "interrupted").length,
    ).toBeGreaterThan(0);
  });

  /**
   * The completion conditions, driven end to end (#238).
   *
   * Completion used to be whatever was left when nothing else went wrong: not
   * interrupted, no bound reached, therefore complete. These four ask the
   * operation to have earned the word — its planned coverage worked, every
   * lead dispositioned, expansion gone quiet — and to say so honestly when it
   * has not.
   */
  it("completes with explicit gaps and a recorded disposition for every lead", async () => {
    const quote = "Maya Okafor designed the Atlas scheduler.";
    const h = compose({
      search: async (query) =>
        query.includes("Okafor")
          ? [{ url: "https://records.example/okafor", title: "Public record", snippet: quote }]
          : [],
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/html",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: `<article><p>${quote}</p></article>`,
        }),
      },
      complete: () => async () => extractedClaim(quote),
    });
    const profile = h.people.profiles.create({ fullName: "Maya Okafor" });
    await h.people.queue.tick();

    const outcome = h.people.research.outcome(profile.id)!;
    expect(outcome.conclusion).toBe("completed");
    /* Every lead the operation ever considered says where it ended and why:
       "the query list ran out" is not a disposition. */
    expect(outcome.leads.filter((lead) => lead.disposition === "pending")).toEqual([]);
    expect(outcome.leads.every((lead) => lead.reason.length > 0)).toBe(true);
    /* And no planned coverage area is still merely planned: a completed
       operation worked its plan rather than stopping when the leads ran out. */
    expect(outcome.coverage.filter((area) => area.state === "planned")).toEqual([]);
    /* Completion publishes what stayed unknown instead of implying it found
       everything. */
    expect(outcome.gaps.length).toBeGreaterThan(0);
    expect(outcome.gaps).toContain(
      "Completion means the planned coverage and every actionable lead were accounted for. It does not mean every public fact about this person was found.",
    );
  });

  it("refuses to complete while actionable leads are still unresolved", async () => {
    const quote = "Maya Okafor shipped the record.";
    const h = compose({
      search: async (query) =>
        query.includes("Okafor")
          ? Array.from({ length: 24 }, (_, index) => ({
              url: `https://records.example/okafor-${index + 1}`,
              title: "Public record",
              snippet: quote,
            }))
          : [],
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/html",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: `<article><p>${quote}</p></article>`,
        }),
      },
      complete: () => async () => extractedClaim(quote),
    });
    /* The shape the spec objected to: a handful investigated against a long
       tail that nothing ever looked at. The loop upholds this by construction
       — its only completing exit needs an empty pending list — so this pins
       the invariant rather than reporting a bug, and the completion policy's
       own suite asks the condition directly. */
    h.people.queue.configure({ profileCalls: 2 });
    const profile = h.people.profiles.create({ fullName: "Maya Okafor" });
    await h.people.queue.tick();

    const outcome = h.people.research.outcome(profile.id)!;
    expect(outcome.conclusion).toBe("bounded");
    const investigated = outcome.leads.filter((lead) => lead.disposition === "investigated");
    const unresolved = outcome.leads.filter((lead) => lead.disposition === "interrupted");
    expect(unresolved.length).toBeGreaterThan(investigated.length);
    /* Unresolved is a disposition with a reason, not an absence of one, and
       nothing is left `pending` in the durable record. */
    expect(outcome.leads.filter((lead) => lead.disposition === "pending")).toEqual([]);
    expect(unresolved.every((lead) => lead.reason.length > 0)).toBe(true);
    expect(h.people.queue.status().jobs[0]?.state).toBe("incomplete");
  });

  it("does not record a refused search as coverage it investigated", async () => {
    const h = compose({
      search: () => {
        throw new PublicSearchUnavailableError("Every provider refused this query.");
      },
    });
    const profile = h.people.profiles.create({ fullName: "Maya Okafor" });
    await h.people.queue.tick();

    const outcome = h.people.research.outcome(profile.id)!;
    /* Every query was refused, so nothing was investigated. A refused search
       is an attempt, not a report that the family holds nothing about this
       person, and the plan says so rather than claiming it looked. */
    expect(outcome.coverage.some((area) => area.state === "investigated")).toBe(false);
    expect(outcome.coverage.every((area) => area.state === "inaccessible")).toBe(true);
    expect(outcome.leads.every((lead) => lead.disposition === "inaccessible")).toBe(true);
    expect(h.people.queue.status().jobs[0]?.state).toBe("unavailable");
  });

  it("reports an interruption during discovery as interrupted rather than complete", async () => {
    let discovering!: () => void;
    const started = new Promise<void>((resolve) => {
      discovering = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = compose({
      search: async () => {
        discovering();
        await held;
        return [];
      },
    });
    const profile = h.people.research.startFor({ fullName: "Maya Okafor" });
    const pending = h.people.research.runNow(profile.id);
    await started;
    h.people.stop();
    release();
    await pending;

    const outcome = h.people.research.outcome(profile.id)!;
    expect(outcome.conclusion).toBe("interrupted");
    expect(outcome.interruption?.code).toBe("lifecycle-invalidated");
    expect(outcome.leads.filter((lead) => lead.disposition === "pending")).toEqual([]);
    /* A coverage area the operation was still working when it stopped is
       recorded as interrupted, never as investigated and never as planned. */
    expect(outcome.coverage.every((area) => area.state !== "planned")).toBe(true);
    expect(outcome.coverage.some((area) => area.state === "interrupted")).toBe(true);
  });

  it("reports an interruption during reading as interrupted rather than complete", async () => {
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = compose({
      researchTestPorts: {
        fetch: async (url) => {
          reading();
          await held;
          return {
            url,
            status: 200,
            contentType: "text/html",
            etag: null,
            lastModified: null,
            retryAfter: null,
            body: "<article><p>Maya Okafor shipped the record.</p></article>",
          };
        },
      },
    });
    const profile = h.people.research.startFor({
      fullName: "Maya Okafor",
      profileUrls: ["https://records.example/okafor"],
    });
    const pending = h.people.research.runNow(profile.id);
    await started;
    h.people.stop();
    release();
    await pending;

    const outcome = h.people.research.outcome(profile.id)!;
    expect(outcome.conclusion).toBe("interrupted");
    const lead = outcome.leads.find((entry) => entry.target === "https://records.example/okafor")!;
    expect(lead.disposition).toBe("interrupted");
    expect(lead.reason).toContain("interrupted");
  });

  it("retains useful evidence beyond the former eight-result reading cutoff", async () => {
    const quote = "maya@example.com designed the Atlas scheduler.";
    const h = compose({
      search: async () =>
        Array.from({ length: 9 }, (_, index) => ({
          url: `https://example.com/record-${index + 1}`,
          title: "Public record",
          snippet: "",
        })),
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: url.endsWith("record-9") ? quote : "A different person's record.",
        }),
      },
      complete: () => async () => ({
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
      }),
    });
    h.people.queue.configure({ profileCalls: 100 });
    const profile = h.people.profiles.create({ primaryEmail: "maya@example.com" });
    await h.people.queue.tick();
    const dossier = h.people.dossiers.get(profile.id);
    expect(dossier?.claims.map((claim) => claim.statement)).toContain(quote);
    const sourceId = dossier!.claims[0].citations[0].sourceId;
    expect(h.people.dossiers.source(profile.id, sourceId)).toMatchObject({
      url: "https://example.com/record-9",
      text: quote,
    });
  });

  it("gives every handle one Workspace, so a Profile created through one is seen by the rest", () => {
    const h = compose();
    const created = h.people.profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });

    expect(h.people.store.list().map((profile) => profile.id)).toContain(created.id);
    expect(h.people.profiles.get(created.id)?.fullName).toBe("Grace Hopper");
    /* The resolver reads the same store rather than a second copy of it. */
    expect(h.people.resolver.get(created.id)?.fullName).toBe("Grace Hopper");
  });

  it("re-enqueues a Profile when its confirmed Transcript evidence changes", async () => {
    const h = compose();
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c1",
      },
    ]);

    await h.people.queue.tick();
    const first = h.people.queue.status().jobs.find((job) => job.profileId === profile.id);
    expect(first?.evidenceRevision).toBe(JSON.stringify([["drive_a_r1", "c1"]]));

    /* A re-ingested Transcript with new bytes is new evidence: the Catalog
       answers with a different checksum, and the research has to be redone. */
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c2",
      },
    ]);
    await h.people.queue.tick();

    const second = h.people.queue.status().jobs.find((job) => job.profileId === profile.id);
    expect(second?.evidenceRevision).not.toBe(first?.evidenceRevision);
    expect(second?.reasons).toContain("evidence");
    expect(second?.attempts).toBe(2);
  });

  it("derives one evidence pair per Confirmed Identity Decision, not per Transcript", async () => {
    const h = compose();
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    const once: ConfirmedTranscript = {
      transcriptId: "drive_a_r1",
      fileName: "Sync.md",
      text: "Grace shipped Atlas.",
      checksum: "c1",
    };
    h.evidence.set(profile.id, [once]);
    await h.people.queue.tick();
    const oneDecision = h.people.queue
      .status()
      .jobs.find((job) => job.profileId === profile.id)?.evidenceRevision;

    /* Two Confirmed Identity Decisions naming the same Transcript are two
       entries. Collapsing them would change every stored revision at once
       and re-research the whole Workspace for nothing. */
    h.evidence.set(profile.id, [once, once]);
    await h.people.queue.tick();

    expect(
      h.people.queue.status().jobs.find((job) => job.profileId === profile.id)?.evidenceRevision,
    ).not.toBe(oneDecision);
  });

  it("enqueues the Profiles that a participant email of an upcoming Meeting names", async () => {
    const h = compose();
    const attending = h.people.profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    const absent = h.people.profiles.create({
      fullName: "Alan Turing",
      primaryEmail: "alan@example.com",
    });
    h.upcoming.push("grace@example.com");

    await h.people.queue.tick();

    const jobs = h.people.queue.status().jobs;
    expect(jobs.find((entry) => entry.profileId === attending.id)?.reasons).toContain("meeting");
    /* Everyone is backfilled; only the attendee is queued for the Meeting. */
    expect(jobs.find((entry) => entry.profileId === absent.id)?.reasons).not.toContain("meeting");
  });

  it("holds research while the Workspace says it is not enabled", async () => {
    const h = compose();
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.enabled.value = false;

    await h.people.queue.tick();

    const job = h.people.queue.status().jobs.find((entry) => entry.profileId === profile.id);
    expect(job).toBeUndefined();
    expect(h.people.queue.status().usedCalls).toBe(0);
    expect(h.people.dossiers.get(profile.id)).toBeNull();
  });

  it("researches duplicate confirmed mentions once and purges the resulting dossier claims", async () => {
    let extractions = 0;
    const h = compose({
      complete: () => async () => {
        extractions += 1;
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
              statement: "Grace shipped Atlas.",
              status: "supported",
              nature: "statement",
              matchConfidence: "high",
              effectiveFrom: null,
              effectiveTo: null,
              citations: [{ sourceId: "source", quote: "Grace shipped Atlas." }],
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
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    const transcript: ConfirmedTranscript = {
      transcriptId: "drive_a_r1",
      fileName: "Sync.md",
      text: "Grace shipped Atlas.",
      checksum: "c1",
    };
    h.evidence.set(profile.id, [transcript, transcript]);

    await h.people.queue.tick();

    expect(extractions).toBe(1);
    const dossier = h.people.dossiers.get(profile.id)!;
    expect(dossier.claims).toHaveLength(1);
    expect(
      h.people.dossiers.source(profile.id, dossier.claims[0].citations[0].sourceId),
    ).toMatchObject({
      transcriptId: transcript.transcriptId,
      visibility: "private",
      text: transcript.text,
    });
    const consumer = h.people.transcriptConsumers.find(
      (entry) => entry.consumer === "person-dossiers",
    )!;
    expect(consumer.purge(transcript.transcriptId)).toBe(1);
    expect(h.people.dossiers.get(profile.id)?.claims).toEqual([]);
    expect(consumer.purge(transcript.transcriptId)).toBe(0);
  });

  it("does not retain a Transcript whose confirmation or checksum is no longer current", async () => {
    const h = compose({ transcriptStillConfirmed: () => false });
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c1",
      },
    ]);

    await h.people.queue.tick();

    expect(h.people.dossiers.get(profile.id)?.sourceIds ?? []).toEqual([]);
  });

  it("does not publish claims when a Transcript is invalidated during extraction", async () => {
    let confirmed = true;
    let extractions = 0;
    const h = compose({
      transcriptStillConfirmed: () => confirmed,
      complete: () => async () => {
        extractions += 1;
        confirmed = false;
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
              statement: "Grace shipped Atlas.",
              status: "supported",
              nature: "statement",
              matchConfidence: "high",
              effectiveFrom: null,
              effectiveTo: null,
              citations: [{ sourceId: "source", quote: "Grace shipped Atlas." }],
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
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c1",
      },
    ]);

    await h.people.queue.tick();

    expect(extractions).toBe(1);
    expect(h.people.dossiers.get(profile.id)?.claims).toEqual([]);
  });

  it("privacy-deletes the dossier and queued research through the Profiles handle", async () => {
    const h = compose();
    const profile = h.people.profiles.create({ fullName: "Grace Hopper" });
    h.evidence.set(profile.id, [
      {
        transcriptId: "drive_a_r1",
        fileName: "Sync.md",
        text: "Grace shipped Atlas.",
        checksum: "c1",
      },
    ]);
    await h.people.queue.tick();
    expect(h.people.queue.status().jobs).toHaveLength(1);
    /* A schema-valid extraction retains the document twice — before the call
       (retryable) and at publication — so pin the count only from below. */
    expect(h.people.dossiers.get(profile.id)!.sourceIds.length).toBeGreaterThan(0);

    h.people.profiles.privacyDelete(profile.id, { confirmation: "DELETE PROFILE" });

    expect(h.people.profiles.get(profile.id)).toBeNull();
    expect(h.people.dossiers.get(profile.id)).toBeNull();
    expect(h.people.queue.status().jobs).toEqual([]);
  });

  it("registers both of Person Profiles' transcript-deletion consumers", () => {
    const h = compose();

    expect(h.people.transcriptConsumers.map((registry) => registry.consumer)).toEqual([
      "person-profiles",
      "person-dossiers",
    ]);
  });
});

it("preserves a repost's actual author and post identity in retained social evidence", async () => {
  const url = "https://bsky.app/profile/maya.example";
  const h = compose({
    researchTestPorts: {
      fetch: async (target) => ({
        url: target,
        status: 200,
        contentType: "application/json",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: JSON.stringify({
          feed: [
            {
              reason: { $type: "app.bsky.feed.defs#reasonRepost" },
              post: {
                uri: "at://did:plc:other/app.bsky.feed.post/abc",
                author: { did: "did:plc:other", handle: "other.example" },
                record: { text: "I built the ocean sensor.", createdAt: "2026-09-01T00:00:00Z" },
              },
            },
          ],
        }),
      }),
    },
    complete: () => async () => ({ fullName: null, claims: [] }),
  });
  const profile = h.people.research.startFor({ fullName: "Maya", profileUrls: [url] });
  await h.people.research.runNow(profile.id);
  const text = h.people.research
    .sources(profile.id)
    .map((source) => source.text)
    .join("\n");
  expect(text).toContain("other.example");
  expect(text).toContain("at://did:plc:other/app.bsky.feed.post/abc");
  expect(text).toContain("repost");
  expect(text).not.toContain("Public Bluesky posts by maya.example");
});

it("broadens empty discovery and retains useful evidence beyond the first reading batch", async () => {
  const h = compose({
    search: async (query) =>
      query.includes("registry filing licence")
        ? Array.from({ length: 60 }, (_, index) => ({
            url: `https://registry.example/maya/${index}`,
            title: "Maya public record",
            snippet: "Maya research record",
          }))
        : [],
    researchTestPorts: {
      fetch: async (url) => ({
        url,
        status: 200,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: `Maya research record ${url.endsWith("/59") ? "including the ocean sensor contribution" : "listing"}.`,
      }),
    },
    complete: () => async () => ({
      fullName: "Maya",
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  const profile = h.people.research.startFor({ fullName: "Maya" });
  const outcome = await h.people.research.runNow(profile.id);
  expect(
    h.people.research
      .sources(profile.id)
      .some((source) => source.text.includes("ocean sensor contribution")),
  ).toBe(true);
  expect(outcome?.attempts).toContainEqual(expect.objectContaining({ code: "selection-deferred" }));
  expect(outcome?.leads.find((lead) => lead.target.endsWith("/59"))?.disposition).toBe(
    "investigated",
  );
});

it.each([
  '<script>window.config={"wgConfirmEditCaptchaNeededForGenericEdit":"hcaptcha","wgConfirmEditForceShowCaptcha":false};</script>',
  "<p>Her published research studies captcha accessibility and its effect on disabled readers.</p>",
])("retains a readable biography with incidental captcha content: %s", async (incidental) => {
  const url = "https://biography.example/maya";
  const h = compose({
    researchTestPorts: {
      fetch: async (target) => ({
        url: target,
        status: 200,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: `<html><head><title>Maya Chen</title></head><body>${incidental}<article><h1>Maya Chen</h1><p>Maya Chen led the ocean sensor project from 2020 to 2024. Her team deployed the equipment at three coastal research stations and published the measurement methods for independent review.</p></article></body></html>`,
      }),
    },
  });
  const profile = h.people.research.startFor({ fullName: "Maya Chen", profileUrls: [url] });
  const outcome = await h.people.research.runNow(profile.id);
  expect(h.people.research.sources(profile.id)).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining("led the ocean sensor project") }),
  );
  expect(outcome?.attempts.some((attempt) => attempt.code === "challenge-page")).toBe(false);
});

it.each([
  ["Forbidden", "http-error"],
  ["<html><body>Please sign in to continue</body></html>", "login-required"],
  ["<html><body>Please solve the following captcha</body></html>", "challenge-page"],
  ["<html><body><script>window._cf_chl_opt={};</script></body></html>", "challenge-page"],
])("classifies denied social access from response evidence: %s", async (body, code) => {
  const h = compose({
    researchTestPorts: {
      fetch: async (url) => ({
        url,
        status: 403,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body,
      }),
    },
  });
  const profile = h.people.research.startFor({
    fullName: "Maya",
    profileUrls: ["https://linkedin.com/in/maya"],
  });
  const outcome = await h.people.research.runNow(profile.id);
  expect(outcome?.attempts).toContainEqual(expect.objectContaining({ stage: "access", code }));
  if (code === "http-error")
    expect(outcome?.attempts.some((attempt) => attempt.code === "login-required")).toBe(false);
});

it("retains a podcast feed and investigates its publisher transcript link", async () => {
  const h = compose({
    researchTestPorts: {
      fetch: async (url) => ({
        url,
        status: 200,
        contentType: url.endsWith(".rss") ? "application/rss+xml" : "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: url.endsWith(".rss")
          ? '<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Maya interviews</title><item><title>Maya on ocean sensors</title><description>Maya explains the work.</description><podcast:transcript url="https://example.com/maya-transcript"/></item></channel></rss>'
          : "Maya at Ocean Lab: We built an ocean sensor using recycled materials.",
      }),
    },
    complete: () => async () => ({
      fullName: "Maya",
      employer: null,
      author: null,
      publishedAt: null,
      sourceClass: "self-report",
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  const profile = h.people.research.startFor({
    fullName: "Maya",
    currentEmployer: "Ocean Lab",
    profileUrls: ["https://example.com/maya.rss"],
  });
  await h.people.research.runNow(profile.id);
  expect(h.people.research.sources(profile.id)).toContainEqual(
    expect.objectContaining({
      url: "https://example.com/maya-transcript",
      text: "Maya at Ocean Lab: We built an ocean sensor using recycled materials.",
    }),
  );
});

it("reports absent captions without presenting a video description as spoken evidence", async () => {
  const h = compose({
    researchTestPorts: {
      fetch: async (url) => ({
        url,
        status: 200,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: '<html><head><meta name="description" content="Maya discusses ocean sensors"></head><body>No caption tracks</body></html>',
      }),
    },
  });
  const profile = h.people.research.startFor({
    fullName: "Maya",
    profileUrls: ["https://www.youtube.com/watch?v=abcdefghijk"],
  });
  const outcome = await h.people.research.runNow(profile.id);
  expect(outcome?.attempts).toContainEqual(
    expect.objectContaining({ stage: "caption-acquisition", code: "captions-missing" }),
  );
  expect(
    h.people.research
      .sources(profile.id)
      .every((source) => source.anchors?.every((anchor) => anchor.kind !== "timestamp") ?? true),
  ).toBe(true);
});

it("preserves a planner outage as an interruption even when discovery is empty", async () => {
  const h = compose({
    plan: () => async () => {
      throw new Error("Planner provider unavailable");
    },
  });
  const profile = h.people.research.startFor({ fullName: "Maya" });
  const outcome = await h.people.research.runNow(profile.id);
  expect(outcome?.conclusion).toBe("interrupted");
  expect(outcome?.attempts).toContainEqual(
    expect.objectContaining({ stage: "planning", code: "model-boundary-failed" }),
  );
});

it.each([
  [
    "https://www.wikidata.org/wiki/Q123",
    "https://www.wikidata.org/wiki/Special:EntityData/Q123.json",
    "wikidata.org",
  ],
  ["https://doi.org/10.1234/maya", "https://api.crossref.org/works/10.1234%2Fmaya", "crossref.org"],
  [
    "https://api.crossref.org/works/10.1234/maya",
    "https://api.crossref.org/works/10.1234/maya",
    "crossref.org",
  ],
  [
    "https://api.datacite.org/dois/10.1234/maya",
    "https://api.datacite.org/dois/10.1234/maya",
    "datacite.org",
  ],
  ["https://openalex.org/A123", "https://api.openalex.org/A123", "openalex.org"],
  [
    "https://orcid.org/0000-0001-0002-0003",
    "https://pub.orcid.org/v3.0/0000-0001-0002-0003/record",
    "orcid.org",
  ],
  ["https://ror.org/012345678", "https://api.ror.org/organizations/012345678", "ror.org"],
  [
    "https://clinicaltrials.gov/study/NCT01234567",
    "https://clinicaltrials.gov/api/v2/studies/NCT01234567",
    "clinicaltrials.gov",
  ],
  [
    "https://npiregistry.cms.hhs.gov/provider-view/1234567890",
    "https://npiregistry.cms.hhs.gov/api/?version=2.1&number=1234567890",
    "npiregistry.cms.hhs.gov",
  ],
  [
    "https://www.tvmaze.com/people/12",
    "https://api.tvmaze.com/people/12?embed=castcredits",
    "tvmaze.com",
  ],
  [
    "https://openlibrary.org/authors/OL123A",
    "https://openlibrary.org/authors/OL123A.json",
    "openlibrary.org",
  ],
  ["https://www.artic.edu/artworks/12", "https://api.artic.edu/api/v1/artworks/12", "artic.edu"],
  ["https://www.loc.gov/item/12/", "https://www.loc.gov/item/12/?fo=json", "loc.gov"],
])(
  "retains quotable public record text and its upstream provenance: %s",
  async (url, endpoint, index) => {
    const h = compose({
      researchTestPorts: {
        fetch: async (target) => ({
          url: target,
          status: target === endpoint ? 200 : 404,
          contentType: "application/json",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: JSON.stringify({
            name: "Maya Chen",
            work: [
              {
                title: "Ocean sensor",
                year: 2024,
                active: true,
                link: "https://example.com/sensor",
              },
            ],
          }),
        }),
      },
    });
    const profile = h.people.research.startFor({ fullName: "Maya Chen", profileUrls: [url] });
    await h.people.research.runNow(profile.id);
    expect(h.people.research.sources(profile.id)).toContainEqual(
      expect.objectContaining({
        upstreamIndex: index,
        text: expect.stringContaining("work[0].title: Ocean sensor"),
        outboundUrls: ["https://example.com/sensor"],
      }),
    );
  },
);

it("retains browser-recovered text with the failed challenge attempt", async () => {
  const h = compose({
    researchTestPorts: {
      fetch: async (url) => ({
        url,
        status: 403,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: "Please complete the following challenge",
      }),
    },
    render: async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      body: "<html><body><article><p>Maya Chen designed an ocean sensor for coastal monitoring.</p></article></body></html>",
    }),
  });
  const profile = h.people.research.startFor({
    fullName: "Maya Chen",
    profileUrls: ["https://example.com/maya"],
  });
  const outcome = await h.people.research.runNow(profile.id);
  expect(h.people.research.sources(profile.id)).toContainEqual(
    expect.objectContaining({
      text: expect.stringContaining("coastal monitoring"),
      acquisition: "browser-renderer",
    }),
  );
  const recovered = outcome?.attempts.find(
    (attempt) => attempt.stage === "rendering" && attempt.code === "retrieval-recovered",
  );
  expect(recovered?.attemptOf).toBeTruthy();
  expect(outcome?.attempts).toContainEqual(
    expect.objectContaining({
      attemptOf: recovered?.attemptOf,
      outcome: "failed",
      stage: "access",
    }),
  );
});

it("reads a real PDF text layer through the composition's byte transport", async () => {
  const stream = "BT /F1 12 Tf 72 720 Td (Maya Chen designed the coastal sensor.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF`;
  const h = compose({
    researchTestPorts: {
      fetch: async () => {
        throw new Error("PDF bytes must not pass through the text transport");
      },
      fetchBytes: async (url) => ({
        url,
        status: 200,
        contentType: "application/pdf",
        retryAfter: null,
        bytes: Buffer.from(pdf),
      }),
    },
  });
  const profile = h.people.research.startFor({
    fullName: "Maya Chen",
    profileUrls: ["https://example.com/maya.pdf"],
  });
  await h.people.research.runNow(profile.id);
  expect(h.people.research.sources(profile.id)).toContainEqual(
    expect.objectContaining({
      acquisition: "document-reader",
      text: expect.stringContaining("Maya Chen designed the coastal sensor."),
    }),
  );
});

it("retains publisher caption timestamps without inventing speaker identity", async () => {
  const h = compose({
    researchTestPorts: {
      fetch: async (url) => ({
        url,
        status: 200,
        contentType: url.includes("timedtext") ? "text/xml" : "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: url.includes("timedtext")
          ? '<transcript><text start="65.5">Maya Chen built coastal sensors &amp; monitors.</text></transcript>'
          : '<script>{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abcdefghijk"}]}</script>',
      }),
    },
  });
  const profile = h.people.research.startFor({
    fullName: "Maya Chen",
    profileUrls: ["https://www.youtube.com/watch?v=abcdefghijk"],
  });
  await h.people.research.runNow(profile.id);
  expect(h.people.research.sources(profile.id)).toContainEqual(
    expect.objectContaining({
      acquisition: "caption-reader",
      text: "Maya Chen built coastal sensors & monitors.",
      author: null,
      anchors: [{ kind: "timestamp", value: "01:05", offset: 0 }],
    }),
  );
});

it("reads an anonymous Mastodon account's dated public statuses", async () => {
  const h = compose({
    researchTestPorts: {
      fetch: async (url) => ({
        url,
        status: 200,
        contentType: "application/json",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: url.includes("/lookup?")
          ? '{"id":"123"}'
          : JSON.stringify([
              {
                created_at: "2026-09-01",
                content: "<p>Maya Chen released the coastal sensor report.</p>",
              },
            ]),
      }),
    },
  });
  const profile = h.people.research.startFor({
    fullName: "Maya Chen",
    profileUrls: ["https://mastodon.social/@maya"],
  });
  await h.people.research.runNow(profile.id);
  expect(h.people.research.sources(profile.id)).toContainEqual(
    expect.objectContaining({
      acquisition: "mastodon",
      text: expect.stringContaining("2026-09-01 — Maya Chen released the coastal sensor report."),
      upstreamIndex: "mastodon.social",
    }),
  );
});

it.each([
  [
    "nppes",
    {
      results: [
        {
          number: 1234567890,
          basic: { first_name: "Maya", last_name: "Chen", credential: "MD", status: "A" },
          taxonomies: [{ desc: "Medicine" }],
        },
      ],
    },
    "https://npiregistry.cms.hhs.gov/provider-view/1234567890",
  ],
  [
    "crossref",
    {
      message: {
        items: [
          {
            DOI: "10.1234/maya",
            title: ["Maya Chen study"],
            author: [{ given: "Maya", family: "Chen" }],
          },
        ],
      },
    },
    "https://doi.org/10.1234/maya",
  ],
  [
    "datacite",
    {
      data: [
        {
          attributes: {
            doi: "10.1234/maya",
            titles: [{ title: "Maya Chen dataset" }],
            creators: [{ name: "Maya Chen" }],
          },
        },
      ],
    },
    "https://doi.org/10.1234/maya",
  ],
  [
    "clinicaltrials",
    {
      studies: [
        {
          protocolSection: {
            identificationModule: {
              nctId: "NCT01234567",
              briefTitle: "Maya Chen trial",
              officialTitle: "Clinical trial",
            },
          },
        },
      ],
    },
    "https://clinicaltrials.gov/study/NCT01234567",
  ],
  [
    "nonprofit-explorer",
    {
      organizations: [
        {
          ein: 123456789,
          name: "Maya Chen Foundation",
          city: "Boston",
          state: "MA",
          ntee_classification: "Research",
        },
      ],
    },
    "https://projects.propublica.org/nonprofits/organizations/123456789",
  ],
  [
    "tvmaze",
    [
      {
        person: {
          url: "https://www.tvmaze.com/people/12",
          name: "Maya Chen",
          country: { name: "Canada" },
          birthday: "1980-01-01",
        },
      },
    ],
    "https://www.tvmaze.com/people/12",
  ],
  [
    "library-of-congress",
    {
      results: [
        {
          id: "https://www.loc.gov/item/12/",
          title: ["Maya Chen lecture"],
          description: ["Interview"],
        },
      ],
    },
    "https://www.loc.gov/item/12/",
  ],
  [
    "artic",
    {
      data: [
        { id: 12, title: "Maya Chen landscape", artist_display: "Maya Chen", date_display: "2024" },
      ],
    },
    "https://www.artic.edu/artworks/12",
  ],
  [
    "open-library",
    {
      docs: [
        {
          key: "OL123A",
          name: "Maya Chen",
          top_work: "Ocean sensors",
          work_count: 2,
          birth_date: "1980",
        },
      ],
    },
    "https://openlibrary.org/authors/OL123A",
  ],
  [
    "mwmbl",
    [
      {
        url: "https://example.com/maya",
        title: [{ value: "Maya Chen", bold: true }],
        extract: [{ value: "Ocean sensors" }],
      },
    ],
    "https://example.com/maya",
  ],
  [
    "peertube",
    {
      data: [
        {
          url: "https://tube.example/videos/watch/maya",
          name: "Maya Chen",
          description: "Ocean sensors",
          publishedAt: "2024-01-01",
        },
      ],
    },
    "https://tube.example/videos/watch/maya",
  ],
  [
    "podcast-directory",
    {
      results: [
        {
          feedUrl: "https://example.com/maya.rss",
          collectionName: "Maya Chen",
          artistName: "Maya Chen",
          primaryGenreName: "Science",
        },
      ],
    },
    "https://example.com/maya.rss",
  ],
  [
    "bluesky",
    {
      actors: [{ handle: "maya.example", displayName: "Maya Chen", description: "Ocean sensors" }],
    },
    "https://bsky.app/profile/maya.example",
  ],
] as const)(
  "production discovery keeps substantive %s records as research leads",
  async (provider, body, expectedUrl) => {
    const { createPublicSearch } = await import("../../../apps/server/src/source-adapters/search");
    const search = createPublicSearch(
      async (url) => ({
        url,
        status: 200,
        contentType: "application/json",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: JSON.stringify(body),
      }),
      undefined,
      { providerFilter: (name) => name === provider },
    );
    const h = compose({
      search,
      researchTestPorts: {
        fetch: async (url) => ({
          url,
          status: 404,
          contentType: "text/plain",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: "Not found",
        }),
      },
    });
    const profile = h.people.research.startFor({ fullName: "Maya Chen" });
    const outcome = await h.people.research.runNow(profile.id);
    expect(outcome?.leads).toContainEqual(
      expect.objectContaining({ target: expectedUrl, disposition: "inaccessible" }),
    );
  },
);

it("reads revised Transcript evidence when a bounded operation was already queued", async () => {
  const h = compose({
    complete: () => async () => ({
      fullName: "Grace Hopper",
      employer: null,
      author: null,
      publishedAt: null,
      sourceClass: "self-report",
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  h.people.queue.configure({ profileCalls: 1 });
  const profile = h.people.research.startFor({ fullName: "Grace Hopper" });
  const transcript = {
    transcriptId: "drive_a_r1",
    fileName: "Sync.md",
    text: "Grace shipped Atlas.",
    checksum: "c1",
  };
  h.evidence.set(profile.id, [transcript]);
  const first = await h.people.research.runNow(profile.id);
  expect(first?.conclusion).toBe("bounded");
  h.people.queue.configure({ profileCalls: 10 });
  h.people.queue.enqueue(profile.id, "explicit");
  h.evidence.set(profile.id, [{ ...transcript, text: "Grace shipped Beacon.", checksum: "c2" }]);
  await h.people.queue.tick();
  const dossier = h.people.dossiers.get(profile.id)!;
  expect(dossier.sourceIds.map((id) => h.people.dossiers.source(profile.id, id)?.text)).toContain(
    "Grace shipped Beacon.",
  );
});

it("keeps unfinished traversal when a bounded operation is explicitly requeued", async () => {
  const h = compose({
    search: async () =>
      [1, 2].map((index) => ({
        url: `https://example.com/maya-${String(index)}`,
        title: "Maya Chen",
        snippet: "Maya Chen",
      })),
    researchTestPorts: {
      fetch: async (url) => ({
        url,
        status: 200,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: `Maya Chen evidence from ${url}`,
      }),
    },
    complete: () => async () => ({
      fullName: "Maya Chen",
      employer: null,
      author: null,
      publishedAt: null,
      sourceClass: "self-report",
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  h.people.queue.configure({ profileCalls: 1, readConcurrency: 1 });
  const profile = h.people.research.startFor({ fullName: "Maya Chen" });
  const first = await h.people.research.runNow(profile.id);
  expect(first?.conclusion).toBe("bounded");
  h.people.queue.configure({ profileCalls: 10 });
  const second = await h.people.research.runNow(profile.id);
  expect(second?.operationId).toBe(first?.operationId);
  expect(second?.attempts).toEqual(expect.arrayContaining(first?.attempts ?? []));
  expect(second?.conclusion).toBe("completed");
});

it("fences a publication when archive occurs inside the serialized write boundary", async () => {
  let profileId = "";
  const quote = "Maya built Atlas.";
  const h = compose({
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
    complete: () => async () => {
      queueMicrotask(() => queueMicrotask(() => h.people.profiles.archive(profileId)));
      return {
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [
          {
            id: "work",
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
  });
  profileId = h.people.research.startFor({
    fullName: "Maya",
    profileUrls: ["https://example.com/maya"],
  }).id;
  await h.people.research.runNow(profileId);
  expect(h.people.profiles.get(profileId)?.archivedAt).not.toBeNull();
  expect(h.people.research.dossier(profileId)?.claims ?? []).toEqual([]);
});

it("runs the requested Profile without dispatching an older eligible Profile", async () => {
  const h = compose();
  const older = h.people.research.startFor({ fullName: "Older person" });
  h.people.queue.enqueue(older.id, "explicit");
  const requested = h.people.research.startFor({ fullName: "Requested person" });
  const result = await h.people.research.runNow(requested.id);
  expect(result?.profileId).toBe(requested.id);
  expect(h.people.research.outcome(older.id)).toBeNull();
});

it("keeps both runtimes' research jobs when two compositions share one Workspace", async () => {
  /* The benchmark researches fixed-document people concurrently over a single
     workspaceDir (#233), so several composed runtimes persist queue state to
     the same person-research.json. Both queues load before either writes, so
     an instance that rewrites only its own snapshot drops the other's jobs
     and the operation records a later composition reads back. */
  const first = compose();
  const second = compose({ workspaceDir: first.root });
  const a = first.people.research.startFor({ fullName: "Concurrent person A" });
  const b = second.people.research.startFor({ fullName: "Concurrent person B" });
  first.people.queue.enqueue(a.id, "explicit");
  second.people.queue.enqueue(b.id, "explicit");
  await first.people.research.runNow(a.id);
  await second.people.research.runNow(b.id);
  const state = PersonResearchStatusSchema.parse(
    JSON.parse(readFileSync(join(first.root, "person-research.json"), "utf8")),
  );
  expect(state.jobs.map((job) => job.profileId).sort()).toEqual([a.id, b.id].sort());
});
