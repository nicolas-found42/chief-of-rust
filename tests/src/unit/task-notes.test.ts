import { describe, expect, it } from "vitest";
import { composeTaskNotes, normalizeDue } from "../../../apps/server/src/google/tasks";

const source = { sourceFileName: "sample-transcript.md", sourceUrl: "https://example/t" };

describe("composeTaskNotes (createTask_ parity)", () => {
  it("composes all lines in the exact routine order", () => {
    const notes = composeTaskNotes(
      {
        title: "Send updated Q3 pricing sheet to Acme",
        owner: "Dana",
        due: "2026-08-31",
        notes: "Renewal is end of month; hold at current tier.",
        sourceQuote: "I'll send them the sheet with that reflected",
      },
      source,
    );
    expect(notes).toBe(
      [
        "Owner: Dana",
        "Renewal is end of month; hold at current tier.",
        'Quote: "I\'ll send them the sheet with that reflected"',
        "Source: sample-transcript.md",
        "https://example/t",
      ].join("\n"),
    );
  });

  it("omits absent lines entirely", () => {
    const notes = composeTaskNotes(
      { title: "Do the thing" },
      { sourceFileName: "a.md", sourceUrl: null },
    );
    expect(notes).toBe("Source: a.md");
  });

  it("handles a task with no source file name", () => {
    const notes = composeTaskNotes(
      { title: "T", owner: "Sam" },
      { sourceFileName: "", sourceUrl: null },
    );
    expect(notes).toBe("Owner: Sam");
  });
});

describe("normalizeDue", () => {
  it("expands YYYY-MM-DD to midnight UTC RFC 3339", () => {
    expect(normalizeDue("2026-08-21")).toBe("2026-08-21T00:00:00Z");
  });

  it("passes through an already-RFC3339 value untouched", () => {
    expect(normalizeDue("2026-08-21T12:00:00Z")).toBe("2026-08-21T12:00:00Z");
  });
});
