import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PersonResearchObservationSchema } from "@chief-of-staff-demo/shared";
import {
  ModelBoundaryError,
  modelBoundaryDiagnostic,
  modelBoundaryFailure,
} from "../../../apps/server/src/llm/failure.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([1e20, -1e20, 1.5, Infinity, NaN])(
  "keeps an upstream failure classified when its numeric code is unusable: %s",
  (code) => {
    const failure = modelBoundaryFailure({
      call: { provider: "openrouter", model: "model", binding: "forced_tool_call" },
      classification: "upstream_error",
      status: 200,
      payload: { error: { code } },
    });
    expect(modelBoundaryDiagnostic(failure)).toMatchObject({
      classification: "upstream_error",
      upstreamCode: null,
      status: 200,
    });
    // Directly constructed classified errors share the same durable boundary.
    expect(
      modelBoundaryDiagnostic(
        new ModelBoundaryError({ ...failure.diagnostic, upstreamCode: code }),
      ),
    ).toMatchObject({ classification: "upstream_error", upstreamCode: null });
  },
);

test.each(["extraction", "planning"] as const)(
  "%s failure preserves classified model observations without response content",
  async (stage) => {
    const root = mkdtempSync(join(tmpdir(), "research-model-diagnostics-"));
    roots.push(root);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
    const failure = modelBoundaryFailure({
      call: { provider: "openrouter", model: "z-ai/glm-5.3-flash", binding: "response_format" },
      classification: "upstream_error",
      status: 200,
      body: "private evidence and secret credentials",
      payload: {
        error: {
          code: 503,
          message: "private evidence and secret credentials",
          metadata: { provider_name: "upstream" },
        },
      },
    });
    const reject = async () => {
      throw failure;
    };
    const research = new PersonResearch({
      dossiers: new PersonDossierStore(root),
      search: async () =>
        stage === "planning"
          ? []
          : [{ url: "https://example.com/maya", title: "Maya", snippet: "" }],
      fetch: async (url) => ({
        url,
        status: 200,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: "maya@example.com built Atlas.",
      }),
      complete: reject,
      ...(stage === "planning" ? { plan: reject } : {}),
    });
    const result = await research.run(
      person,
      researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }),
    );
    const attempt = result.operation.attempts.find(
      (entry) => entry.stage === stage && entry.code === "model-boundary-failed",
    );
    expect(attempt?.observed?.modelBoundary).toEqual(failure.diagnostic);
    expect(attempt?.observed?.modelBoundary).toMatchObject({
      classification: "upstream_error",
      status: 200,
      upstreamCode: 503,
      upstreamServer: "upstream",
      bodyBytes: 39,
    });
    expect(attempt?.observed?.modelDiagnostic).toContain("upstream failure");
    expect(PersonResearchObservationSchema.safeParse(attempt?.observed).success).toBe(true);
    expect(JSON.stringify(attempt)).not.toContain("private evidence");
    expect(JSON.stringify(attempt)).not.toContain("secret credentials");
  },
);

test("model observation identifiers and field counts are sanitized and schema bounded", () => {
  const error = modelBoundaryFailure({
    call: {
      provider: "openrouter",
      model: "https://host/model?api_key=secret",
      binding: "response_format",
    },
    classification: "unusable_shape",
    payload: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field${index}`, "private value"]),
    ),
    answer: { path: "message?api_key=secret", value: { content: "private value" } },
  });
  expect(error.diagnostic.model).toBe("[unnamed]");
  expect(error.diagnostic.topLevelKeys).toHaveLength(64);
  expect(error.diagnostic.populatedFields).toEqual(["[unnamed]"]);
  expect(JSON.stringify(error.diagnostic)).not.toContain("secret");
  expect(JSON.stringify(error.diagnostic)).not.toContain("private value");
  expect(
    PersonResearchObservationSchema.safeParse({ modelBoundary: error.diagnostic }).success,
  ).toBe(true);
  expect(
    PersonResearchObservationSchema.safeParse({
      modelBoundary: { ...error.diagnostic, topLevelKeys: Array(65).fill("field") },
    }).success,
  ).toBe(false);
  expect(
    PersonResearchObservationSchema.safeParse({
      modelBoundary: { ...error.diagnostic, model: "x".repeat(201) },
    }).success,
  ).toBe(false);
});

test("invalid model enum values do not echo evidence into research diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-invalid-shape-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
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
    complete: async () => ({
      fullName: null,
      employer: null,
      author: null,
      publishedAt: null,
      sourceClass: "PRIVATE EVIDENCE MARKER",
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  const result = await research.run(
    person,
    researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }),
  );
  const attempts = result.operation.attempts.filter(
    (attempt) => attempt.code === "invalid-result-shape",
  );
  expect(attempts.length).toBeGreaterThan(0);
  expect(JSON.stringify(attempts)).not.toContain("PRIVATE EVIDENCE MARKER");
  expect(attempts[0]?.reason).toContain("sourceClass");
});

test.each([1, 3])(
  "recovered wire attempts retain evidence within %i logical model calls",
  async (maxModelCalls) => {
    const root = mkdtempSync(join(tmpdir(), "research-recovered-model-"));
    roots.push(root);
    const dossiers = new PersonDossierStore(root);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
    const quote = "Maya Chen built Atlas.";
    const diagnostic = modelBoundaryFailure({
      call: { provider: "openrouter", model: "model", binding: "forced_tool_call" },
      classification: "request_timeout",
      status: 200,
      bodyBytes: 11,
      timeoutMs: 30000,
    }).diagnostic;
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
        body: `maya@example.com. ${quote}`,
      }),
      complete: async (request) => {
        request.retry?.onAttempt({
          attempt: 1,
          binding: "forced_tool_call",
          provider: "openrouter",
          model: "model",
          outcome: "retrying",
          diagnostic,
          delayMs: 500,
          stoppedReason: null,
        });
        expect(request.retry?.canRetry?.()).toBe(true);
        request.retry?.onAttempt({
          attempt: 2,
          binding: "forced_tool_call",
          provider: "openrouter",
          model: "model",
          outcome: "succeeded",
          diagnostic: null,
          delayMs: 0,
          stoppedReason: null,
        });
        return {
          fullName: "Maya Chen",
          employer: null,
          author: null,
          publishedAt: null,
          sourceClass: "primary-artifact",
          claims: [
            {
              id: "built",
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
    const result = await research.run(
      person,
      researchAllowance({ maxModelCalls, maxMilliseconds: 10000 }),
    );
    if (maxModelCalls > 1) expect(result.operation.conclusion).toBe("completed");
    expect(dossiers.get(person.id)?.claims[0]?.statement).toBe(quote);
    expect(result.operation.modelCalls).toBe(1);
    const first = result.operation.attempts.find(
      (attempt) => attempt.code === "model-boundary-failed",
    );
    const second = result.operation.attempts.find(
      (attempt) => attempt.code === "model-response-received",
    );
    expect(first).toMatchObject({
      attempt: 1,
      outcome: "failed",
      recovery: "retry",
      observed: { modelBoundary: diagnostic },
    });
    expect(second).toMatchObject({
      attempt: 2,
      outcome: "recovered",
      recovery: "recovered",
      attemptOf: first?.attemptOf,
    });
  },
);
