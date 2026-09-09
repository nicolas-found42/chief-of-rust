import { describe, expect, it } from "vitest";
import type {
  PersonProfile,
  PersonResearchCoverageArea,
  PersonResearchLead,
} from "@chief-of-staff-demo/shared";
import {
  PublicationGate,
  ResearchBudget,
  evaluateCompletion,
  plannerIsWorthACall,
  retireSurpassedLeads,
  selectReadBatch,
} from "../../../apps/server/src/person-profile/research-policy";
import { researchAllowance } from "../../../apps/server/src/person-profile/research";

/**
 * The four policies one research operation runs under, asked directly.
 *
 * Each of these was a closure inside `PersonResearch.run`, so the only way to
 * ask what the budget does at its ceiling, or which leads selection defers, was
 * to drive a whole operation and infer the answer from its report (#231). The
 * completion conditions joined them for the same reason: whether an operation
 * has earned the word "completed" is a question with an answer, and reading it
 * off a conclusion the loop happened to reach is not asking it (#238).
 */

const profile = (overrides: Partial<PersonProfile> = {}): PersonProfile =>
  ({
    id: "person-1",
    fullName: "Maya Okafor",
    emails: [],
    profileUrls: [],
    employerHints: [],
    currentEmployer: null,
    revision: 1,
    ...overrides,
  }) as PersonProfile;

const area = (
  key: string,
  state: PersonResearchCoverageArea["state"],
  kind: PersonResearchCoverageArea["kind"] = "source-family",
): PersonResearchCoverageArea => ({
  key,
  label: `The ${key} area`,
  kind,
  state,
  sources: 0,
  claims: 0,
  gaps: [],
});

const lead = (target: string, overrides: Partial<PersonResearchLead> = {}): PersonResearchLead => ({
  id: target,
  kind: "url",
  target,
  origin: "discovery",
  coverage: [],
  disposition: "pending",
  reason: "Awaiting investigation.",
  yieldedEvidence: false,
  ...overrides,
});

describe("the allowance policy", () => {
  it("names the first bound it reached rather than the last one checked", () => {
    const budget = new ResearchBudget(researchAllowance({ maxRequests: 1, maxModelCalls: 1 }), {
      active: () => true,
    });
    expect(budget.takeRequest()).toBe(true);
    expect(budget.takeRequest()).toBe(false);
    expect(budget.reason).toMatch(/request ceiling/);
    /* The model call is refused too, but the request ceiling is what actually
       stopped the work, so that is what stays reported. */
    expect(budget.takeModelCall()).toBe(false);
    expect(budget.reason).toMatch(/request ceiling/);
    expect(budget.spentRequests).toBe(1);
    expect(budget.spentModelCalls).toBe(0);
  });

  it("records a Workspace refusal separately from its own ceilings", () => {
    const budget = new ResearchBudget(researchAllowance({ reserveModelCall: () => false }), {
      active: () => true,
    });
    expect(budget.takeModelCall()).toBe(false);
    expect(budget.reason).toBe("The Workspace declined a further model call.");
    expect(budget.spentModelCalls).toBe(0);
  });

  it("treats an interruption as no bound at all", () => {
    const budget = new ResearchBudget(researchAllowance(), { active: () => false });
    expect(budget.takeRequest()).toBe(false);
    /* An interrupted operation is not a bounded one; nothing here may make it
       look like research ran out of allowance. */
    expect(budget.reason).toBeNull();
  });

  it("bounds on wall clock without spending a request to find out", () => {
    let clock = 0;
    const budget = new ResearchBudget(researchAllowance({ maxMilliseconds: 100 }), {
      active: () => true,
      now: () => clock,
    });
    expect(budget.within()).toBe(true);
    clock = 100;
    expect(budget.within()).toBe(false);
    expect(budget.reason).toMatch(/wall-clock backstop/);
  });
});

describe("the collection policy", () => {
  it("reads the best of what was discovered and keeps the rest pending, in score order", () => {
    const scores = new Map<string, number>();
    const candidates = [
      lead("https://elsewhere.example/unrelated"),
      lead("https://news.example/maya-okafor-profile"),
      lead("https://blog.example/maya-okafor-interview"),
    ];
    const { batch, deferred } = selectReadBatch({
      profile: profile(),
      candidates,
      unsatisfied: new Set(),
      context: (_leadId, target) => ({ title: target, snippet: "", rank: 0 }),
      readHosts: new Map(),
      readIndexes: new Map(),
      readConcurrency: 1,
      score: (leadId, selection) => {
        scores.set(leadId, selection.score);
        const found = candidates.find((candidate) => candidate.id === leadId);
        if (found) found.selection = selection;
      },
    });
    /* Concurrency one reads two: enough that a stalled read leaves no reader
       idle, few enough that the next round re-scores against what it learned. */
    expect(batch).toHaveLength(2);
    expect(batch.map((entry) => entry.target)).not.toContain("https://elsewhere.example/unrelated");
    /* Nothing is dropped, and the leftover keeps the score that deferred it. */
    expect(deferred.map((entry) => entry.target)).toEqual(["https://elsewhere.example/unrelated"]);
    expect(scores.get("https://elsewhere.example/unrelated")).toBeLessThan(
      scores.get("https://news.example/maya-okafor-profile")!,
    );
  });

  it("prefers an unread host over a third page from one already read", () => {
    const candidates = [
      lead("https://read.example/maya-okafor-again"),
      lead("https://fresh.example/maya-okafor"),
    ];
    const { batch } = selectReadBatch({
      profile: profile(),
      candidates,
      unsatisfied: new Set(),
      context: (_leadId, target) => ({ title: target, snippet: "", rank: 0 }),
      readHosts: new Map([["read.example", 3]]),
      readIndexes: new Map(),
      readConcurrency: 1,
      score: (leadId, selection) => {
        const found = candidates.find((candidate) => candidate.id === leadId);
        if (found) found.selection = selection;
      },
    });
    expect(batch[0]?.target).toBe("https://fresh.example/maya-okafor");
  });
});
describe("the backlog retirement policy", () => {
  it("decides a lead trailing the batch floor by more than the margin", () => {
    const trailing = lead("https://trailing.example/maya", {
      id: "trailing",
      selection: { score: 5.1, relevance: 1, independence: 2, coverageGap: 0 },
    });
    const surpassed = retireSurpassedLeads({ deferred: [trailing], batchFloor: 8.4, margin: 2 });
    expect(surpassed.map((entry) => entry.id)).toEqual(["trailing"]);
  });

  it("keeps a near-miss lead pending — depth of discovery is never the reason a lead is dropped", () => {
    const nearMiss = lead("https://near.example/maya", {
      id: "near",
      selection: { score: 8.3, relevance: 3, independence: 2, coverageGap: 0 },
    });
    expect(retireSurpassedLeads({ deferred: [nearMiss], batchFloor: 8.4, margin: 2 })).toHaveLength(
      0,
    );
  });
});

describe("the planner throttle", () => {
  it("spends the call only when the pending pool cannot fill the next batch", () => {
    expect(plannerIsWorthACall({ pendingReadable: 1, batchSize: 2 })).toBe(true);
    expect(plannerIsWorthACall({ pendingReadable: 2, batchSize: 2 })).toBe(false);
  });

  it("counts every readable lead, not urls alone — documents fill a batch too", () => {
    expect(plannerIsWorthACall({ pendingReadable: 3, batchSize: 2 })).toBe(false);
  });
});

describe("the publication policy", () => {
  it("admits one writer at a time even when reads finish together", async () => {
    const gate = new PublicationGate();
    const order: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const write = (name: string, delay: number) =>
      gate.publish(async () => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(name);
        inFlight -= 1;
      });
    await Promise.all([write("first", 20), write("second", 0), write("third", 0)]);
    expect(overlapped).toBe(false);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("does not let a failed publication poison the writes queued behind it", async () => {
    const gate = new PublicationGate();
    const failed = gate.publish(() => {
      throw new Error("Publication conflict");
    });
    const after = gate.publish(() => "published");
    await expect(failed).rejects.toThrow("Publication conflict");
    await expect(after).resolves.toBe("published");
  });
});

describe("the completion policy", () => {
  const worked = [
    area("general-discovery", "satisfied"),
    area("career", "investigated", "dossier-section"),
  ];

  it("completes with gaps once coverage was worked, leads are accounted for and expansion went quiet", () => {
    /* Completion is not a claim that the internet was exhausted: an area that
       was investigated and yielded nothing still completes, and its gap is
       what the report carries instead. */
    expect(
      evaluateCompletion({
        coverage: [...worked, area("historical-evidence", "inaccessible")],
        leads: [
          lead("https://news.example/a", { disposition: "investigated", reason: "Read." }),
          lead("https://paywall.example/b", {
            disposition: "inaccessible",
            reason: "The publisher required a login.",
          }),
        ],
        quietRounds: 2,
        requiredQuietRounds: 2,
      }),
    ).toBeNull();
  });

  it("refuses completion while an actionable lead is still unresolved, and names one", () => {
    const shortfall = evaluateCompletion({
      coverage: worked,
      leads: [
        lead("https://news.example/a", { disposition: "investigated", reason: "Read." }),
        lead("https://news.example/unread"),
      ],
      quietRounds: 2,
      requiredQuietRounds: 2,
    });
    expect(shortfall?.condition).toBe("leads-pending");
    expect(shortfall?.reason).toContain("https://news.example/unread");
  });

  it("refuses completion while a planned coverage area was never investigated", () => {
    const shortfall = evaluateCompletion({
      coverage: [...worked, area("spoken-evidence", "planned")],
      leads: [lead("https://news.example/a", { disposition: "investigated", reason: "Read." })],
      quietRounds: 2,
      requiredQuietRounds: 2,
    });
    expect(shortfall?.condition).toBe("coverage-uninvestigated");
    expect(shortfall?.reason).toContain("The spoken-evidence area");
  });

  it("refuses completion while expansion is still producing something new", () => {
    /* "The query list ran out" is not this condition: expansion has to have
       been tried against the thin areas and found nothing further. */
    const shortfall = evaluateCompletion({
      coverage: worked,
      leads: [lead("https://news.example/a", { disposition: "investigated", reason: "Read." })],
      quietRounds: 1,
      requiredQuietRounds: 2,
    });
    expect(shortfall?.condition).toBe("expansion-unfinished");
  });

  it("reports the coverage shortfall ahead of the leads it left pending", () => {
    /* One reason, in the spec's own order, so a bounded operation's detail
       names the condition that actually stopped it rather than the last one
       checked. */
    const shortfall = evaluateCompletion({
      coverage: [area("spoken-evidence", "planned")],
      leads: [lead("https://news.example/unread")],
      quietRounds: 0,
      requiredQuietRounds: 2,
    });
    expect(shortfall?.condition).toBe("coverage-uninvestigated");
  });
});
