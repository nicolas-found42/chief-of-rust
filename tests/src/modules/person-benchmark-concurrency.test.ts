import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  evaluateLivePopulation,
  type EvaluationPorts,
} from "../../../apps/server/src/person-benchmark/evaluate.js";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-concurrent-"));
  roots.push(workspaceDir);
  const reference = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  const selected = [0, 1, 2].map((index) => ({
    ...structuredClone(reference),
    slug: `fixture-${index}`,
    fictional: true,
    facts: [reference.facts[0]],
    lookup: {
      fullName: `Fixture Person ${index}`,
      employerHint: null,
      profileUrls: [`https://example.com/person-${index}`],
      emails: [],
    },
  }));
  const gates = selected.map(() => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { wait, release };
  });
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const ports: EvaluationPorts = {
    workspaceDir,
    search: async () => [],
    seeds: (profile) => profile.profileUrls,
    settings: { profileCalls: 20, profileMilliseconds: 60000, readConcurrency: 1 },
    readSource: async (url) => {
      const index = Number(url.at(-1));
      started.push(index);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gates[index].wait;
      active -= 1;
      return {
        text: `Fixture Person ${index} has a public page.`,
        capturedAt: null,
        completeness: "full",
        access: "retrieved",
        outboundUrls: [],
        family: "documents-publishers",
        route: "fixture",
        upstreamIndex: null,
        publishedAt: null,
        author: null,
        anchors: [],
        provenanceNote: "Controlled parallel research",
        sourceVersion: null,
        rights: null,
        finalUrl: url,
      };
    },
    complete: () => async () => ({
      fullName: null,
      employer: null,
      author: null,
      publishedAt: null,
      sourceClass: "primary-artifact",
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
    judge: async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: reference.facts[0].id,
                verdict: "missing",
                evidence: null,
                claimId: null,
                rationale: "The page has no substantive claim.",
              },
            ],
          }
        : {
            understanding: 0,
            remainingQuestions: 1,
            conversationReadiness: 0,
            uncertain: false,
            overclaims: [],
            rationale: "Explicit gap.",
          },
  };
  return { selected, ports, gates, started, maximumActive: () => maximumActive };
}

it("starts the next research operation while an earlier judge is blocked", async () => {
  const { selected, ports, gates, started } = fixture();
  let releaseJudge!: () => void;
  const judgeGate = new Promise<void>((resolve) => {
    releaseJudge = resolve;
  });
  let judging = 0;
  const pending = evaluateLivePopulation(selected, {
    ...ports,
    concurrency: 1,
    judge: async (request) => {
      judging += 1;
      await judgeGate;
      return ports.judge(request);
    },
  });
  await vi.waitFor(() => expect(started).toEqual([0]));
  gates[0].release();
  await vi.waitFor(() => expect(judging).toBe(1));
  await vi.waitFor(() => expect(started).toEqual([0, 1]));
  gates[1].release();
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
  gates[2].release();
  releaseJudge();
  expect((await pending).evaluations).toHaveLength(3);
});

it("runs two real operations concurrently, keeps the third queued, and returns selection order", async () => {
  const fixtureData = fixture();
  const { selected, ports, gates, started } = fixtureData;
  const finished: number[] = [];
  const pending = evaluateLivePopulation(selected, {
    ...ports,
    concurrency: 2,
    onEvaluated: (_, index) => {
      finished.push(index);
    },
  });
  await vi.waitFor(() => expect(started).toEqual([0, 1]));
  gates[1].release();
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
  expect(finished).toEqual([1]);
  gates[2].release();
  await vi.waitFor(() => expect(finished).toEqual([1, 2]));
  gates[0].release();
  const result = await pending;
  expect(fixtureData.maximumActive()).toBe(2);
  expect(result.evaluations.map((entry) => entry.result.slug)).toEqual(
    selected.map((person) => person.slug),
  );
  expect(new Set(result.evaluations.map((entry) => entry.operation?.operationId)).size).toBe(3);
  expect(result.evaluations.every((entry) => entry.operation !== null)).toBe(true);
  expect(result.evaluations.every((entry) => entry.result.assessment?.judge === "completed")).toBe(
    true,
  );
  expect(result.people.profiles.search()).toHaveLength(3);
  const persisted = JSON.parse(
    readFileSync(join(ports.workspaceDir, "person-research.json"), "utf8"),
  ) as {
    settings: Record<string, number>;
    jobs: { profileId: string; operation: { operationId: string } }[];
  };
  expect(persisted.settings).toMatchObject({
    concurrency: 2,
    profileCalls: 20,
    profileMilliseconds: 60000,
    readConcurrency: 1,
  });
  expect(persisted.jobs).toHaveLength(3);
  expect(persisted.jobs.map((job) => job.operation.operationId).sort()).toEqual(
    result.evaluations.map((entry) => entry.operation!.operationId).sort(),
  );
});

it("waits for other in-flight research before rejecting a worker output failure", async () => {
  const { selected, ports, gates, started } = fixture();
  let settled = false;
  let outputFailed = false;
  const pending = evaluateLivePopulation(selected.slice(0, 2), {
    ...ports,
    concurrency: 2,
    onEvaluated: (_, index) => {
      if (index === 1) {
        outputFailed = true;
        throw new Error("Report storage failed");
      }
    },
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejection = expect(pending).rejects.toThrow("Report storage failed");
  await vi.waitFor(() => expect(started).toEqual([0, 1]));
  gates[1].release();
  await vi.waitFor(() => expect(outputFailed).toBe(true));
  expect(settled).toBe(false);
  gates[0].release();
  await rejection;
  expect(settled).toBe(true);
});

it("rejects duplicate selected people before research", async () => {
  const { selected, ports } = fixture();
  const search = vi.fn(ports.search);
  await expect(
    evaluateLivePopulation([selected[0], selected[0]], {
      ...ports,
      search,
      concurrency: 2,
    }),
  ).rejects.toThrow("unique selected Benchmark People");
  expect(search).not.toHaveBeenCalled();
});
