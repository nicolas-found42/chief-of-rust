import { describe, expect, it } from "vitest";
import type { RunStatus, RunSummary } from "@chief-of-staff-demo/shared";
import { homeStatus } from "../../../apps/web/src/homeStatus";

/**
 * Home's sentence and rail, unit-tested rather than driven through the browser.
 *
 * Two of the five states are unreachable end to end: `quiet` needs a connected
 * Google account, which the e2e workspace has no way to obtain, and `live` needs
 * a Run that stays non-terminal, which the mock provider never produces. The
 * sentence is a pure function of what the Shell observes precisely so those
 * states can be asserted somewhere.
 */
function run(id: string, status: RunStatus, fileName = `${id}.txt`): RunSummary {
  return {
    id,
    createdAt: "2026-08-20T10:00:00.000Z",
    module: "transcript",
    intake: "drive",
    fileName,
    sourceUrl: null,
    status,
    skipReason: null,
    summary: null,
  };
}

const REAL = "openai";

describe("Home's sentence", () => {
  it("says nothing has run yet, and never claims an all-clear there", () => {
    // No Runs is not good news, so the reassurance is absent whether or not the
    // banner has anything to say.
    expect(homeStatus([], REAL, false).sentence).toBe("Nothing has run yet.");
    expect(homeStatus([], REAL, true).sentence).toBe("Nothing has run yet.");
  });

  it("capitalises a leading provider clause, behind the no-Runs prefix", () => {
    // The fresh workspace: nothing uploaded, and the provider still the default
    // stand-in. The clause is written lowercase so it can be joined mid-sentence,
    // so leading with it has to capitalise — and the prefix goes on afterwards.
    expect(homeStatus([], "mock", true).sentence).toBe(
      "Nothing has run yet. The extraction provider is a stand-in.",
    );
  });

  it("enumerates the rail's conditions in the rail's order", () => {
    const runs = [run("r2", "failed"), run("r1", "done")];
    expect(homeStatus(runs, "mock", true).sentence).toBe(
      "1 run failed, and the extraction provider is a stand-in.",
    );
  });

  it("counts the true total of failures, not the rows the rail shows", () => {
    const runs = Array.from({ length: 5 }, (_, i) => run(`r${i}`, "failed"));
    expect(homeStatus(runs, REAL, true).sentence).toBe("5 runs failed.");
  });

  it("reports work in progress, and reassures when nothing is asking", () => {
    const runs = [run("r3", "running"), run("r2", "pending"), run("r1", "done")];
    expect(homeStatus(runs, REAL, false).sentence).toBe(
      "2 runs in progress. Nothing needs your attention.",
    );
    expect(homeStatus([run("r1", "running")], REAL, false).sentence).toBe(
      "1 run in progress. Nothing needs your attention.",
    );
  });

  it("is quiet and clear when every Run is terminal and nothing is asking", () => {
    const runs = [run("r2", "done"), run("r1", "skipped")];
    expect(homeStatus(runs, REAL, false).sentence).toBe(
      "All caught up. Nothing needs your attention.",
    );
  });

  it("drops the all-clear whenever the connection notice is showing", () => {
    // The branch ticket 08 settled. `Nothing needs your attention.` is a claim
    // about the reader's obligations, so Home cannot make it under a banner
    // asking for a sign-in — while "All caught up." stays true, because caught
    // up is about Runs.
    const signedOutAfterSuccess = [run("r2", "done"), run("r1", "done")];
    expect(homeStatus(signedOutAfterSuccess, REAL, true).sentence).toBe("All caught up.");

    // Reachable on day one, with no successful Run and no sign-out: a skipped
    // Run never reaches the outputs stage, so it never fails on the connection.
    const everythingSkipped = [run("r2", "skipped"), run("r1", "skipped")];
    expect(homeStatus(everythingSkipped, REAL, true).sentence).toBe("All caught up.");

    // Same rule for work in progress.
    expect(homeStatus([run("r1", "running")], REAL, true).sentence).toBe("1 run in progress.");
  });
});

describe("Home's activity feed", () => {
  it("shows finished Runs newest first, capped, with humanized titles", () => {
    const runs = [
      {
        ...run("r1", "done", "Stand-up - 2026-06-18T13-00-00.000Z.json"),
        module: "meeting-debrief",
      },
      run("r2", "skipped"),
      run("r3", "failed"),
      run("r4", "running"),
    ];
    const { feed } = homeStatus(runs, REAL, false);
    expect(feed.map((entry) => [entry.title, entry.outcome])).toEqual([
      ["Stand-up — Jun 18", "Completed"],
      ["r2", "Skipped"],
    ]);
    expect(feed.map((entry) => entry.to)).toEqual(["/meeting-debrief/r1", "/people/review"]);
  });

  it("links each entry to the surface that owns the result, never a Run", () => {
    const cases: Array<[string, string]> = [
      ["meeting-brief-generator", "/meetings/brief"],
      ["content-scout", "/content-scout"],
      ["content-research", "/content-research"],
      ["youtube-trends", "/content-research/trends"],
      ["transcript", "/people/review"],
    ];
    for (const [module, to] of cases) {
      const { feed } = homeStatus([{ ...run("r1", "done"), module }], REAL, false);
      expect(feed.map((entry) => entry.to)).toEqual([to]);
    }
    // Meeting Debrief deep-links: its detail page is addressed by the Run id.
    const debrief = homeStatus([{ ...run("r1", "done"), module: "meeting-debrief" }], REAL, false);
    expect(debrief.feed.map((entry) => entry.to)).toEqual(["/meeting-debrief/r1"]);
    // A Module with no product surface left falls back to the diagnostics list.
    const retired = homeStatus([{ ...run("r1", "done"), module: "idea-engine" }], REAL, false);
    expect(retired.feed.map((entry) => entry.to)).toEqual(["/runs/r1"]);
  });

  it("carries the line the Module wrote, and never derives one of its own", () => {
    const wrote = { ...run("r1", "done"), summary: "2 tasks, 1 draft" };
    const said = { ...run("r2", "skipped"), skipReason: "agenda only" };
    const { feed } = homeStatus([wrote, said], REAL, false);
    expect(feed.map((entry) => entry.outcome)).toEqual([
      "Completed — 2 tasks, 1 draft",
      "Skipped — agenda only",
    ]);
  });

  it("is empty when nothing has finished — no zeroes, ever", () => {
    expect(homeStatus([run("r1", "failed")], REAL, true).feed).toEqual([]);
  });

  it("frames a connection-caused failure as reconnect-fixable, in Settings", () => {
    const failed = {
      ...run("r1", "failed", "Pricing call.docx"),
      connectionState: "expired" as const,
    };
    const { sentence, rows } = homeStatus([failed], REAL, true);
    expect(sentence).toBe("1 run needs reconnecting.");
    expect(rows).toEqual([
      {
        id: "r1",
        text: "Pricing call could not finish because Google needs reconnecting",
        cta: "Reconnect",
        to: "/settings",
      },
    ]);
  });

  it("reports a genuine failure separately from a Run that needs reconnecting", () => {
    const interrupted = {
      ...run("r2", "failed"),
      connectionState: "expired" as const,
    };
    const failed = run("r1", "failed");

    expect(homeStatus([interrupted, failed], REAL, true).sentence).toBe(
      "1 run needs reconnecting, and 1 run failed.",
    );
  });
});

describe("Home's attention rail", () => {
  it("is empty when nothing needs action, so the rail is omitted", () => {
    expect(homeStatus([run("r1", "done")], REAL, false).rows).toEqual([]);
  });

  it("opens a failed Run rather than offering to retry it", () => {
    const { rows } = homeStatus([run("r1", "failed", "Pricing call.docx")], REAL, true);
    expect(rows).toEqual([{ id: "r1", text: "Pricing call failed", cta: "Open", to: "/runs/r1" }]);
  });

  it("keeps an indefinite blocked Run visible with the reason it is waiting", () => {
    const waiting = {
      ...run("r1", "blocked", "Content Scout shortlist.md"),
      wait: {
        requestedAt: "2026-08-25T12:00:00.000Z",
        stage: "selection",
        reason: "Choose up to three opportunities or skip this shortlist.",
        timeout: { kind: "none" as const },
      },
    };

    const status = homeStatus([waiting], REAL, false);
    expect(status.sentence).toBe("1 run is waiting for you.");
    expect(status.rows).toEqual([
      {
        id: "r1",
        text: "Content Scout shortlist is waiting: Choose up to three opportunities or skip this shortlist.",
        cta: "Open",
        to: "/runs/r1",
      },
    ]);
  });

  it("names an untitled Run the way the runs table does", () => {
    const { rows } = homeStatus([run("r1", "failed", "")], REAL, true);
    expect(rows[0].text).toBe("Untitled run failed");
  });

  it("shows three failures and summarises the rest, rather than rebuilding the list", () => {
    const runs = Array.from({ length: 5 }, (_, i) => run(`r${i}`, "failed"));
    const { rows } = homeStatus(runs, REAL, true);
    expect(rows.map((row) => row.text)).toEqual([
      "r0 failed",
      "r1 failed",
      "r2 failed",
      "2 more runs failed",
    ]);
    // The tail links to the Shell's cross-Module list, not to one Module's.
    expect(rows[3].to).toBe("/runs");
  });

  it("summarises an expiry-only hidden tail as needing reconnection", () => {
    const runs = Array.from({ length: 4 }, (_, i) => ({
      ...run(`r${i}`, "failed"),
      connectionState: "expired" as const,
    }));

    expect(homeStatus(runs, REAL, true).rows.at(-1)?.text).toBe("1 more run needs reconnecting");
  });

  it("summarises a mixed hidden tail as needing attention", () => {
    const runs = [
      run("r1", "failed"),
      run("r2", "failed"),
      run("r3", "failed"),
      { ...run("r4", "failed"), connectionState: "expired" as const },
      run("r5", "failed"),
    ];

    expect(homeStatus(runs, REAL, true).rows.at(-1)?.text).toBe("2 more runs need attention");
  });

  it("speaks about the mock provider without claiming what extraction would have found", () => {
    const { rows } = homeStatus([], "mock", true);
    expect(rows).toEqual([
      {
        id: "mock-provider",
        text: "Runs are using the mock provider, so nothing real is extracted",
        cta: "Choose a provider",
        to: "/settings",
      },
    ]);
  });

  it("never carries the Google connection, whatever state it is in", () => {
    // It fails the "already visible where the user is standing" test: the Shell
    // banner says it on every page, including this one (ADR-0010).
    const { rows } = homeStatus([run("r1", "failed")], REAL, true);
    expect(rows.some((row) => /google/i.test(`${row.text} ${row.cta}`))).toBe(false);
  });
});
