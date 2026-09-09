import { describe, expect, it } from "vitest";
import { CONTENT_PROJECT_GATES } from "@chief-of-staff-demo/shared";
import {
  contentProjectGateNotices,
  contentProjectReadinessLabel,
} from "../../../apps/web/src/contentProjectGates";

/**
 * How a Content Project's readiness reads on the page (spec #147), unit-tested
 * rather than driven through the browser.
 *
 * A Project reaches most gate combinations only after owner confirmation, an
 * accepted Brand Voice, an authorized author and a frozen evidence set, so
 * asserting each one end to end would mean building four Projects to check four
 * sentences. The mapping is a pure function precisely so those states can be
 * asserted here, in the manner of Home's status sentence.
 */
describe("Content Project gate notices", () => {
  it("says nothing is missing when every gate is clear", () => {
    expect(contentProjectGateNotices({ ready: true, missingGates: [] })).toEqual([]);
  });

  it("names each missing gate in the owner's words, not the domain's token", () => {
    const notices = contentProjectGateNotices({
      ready: false,
      missingGates: ["content-voice", "evidence-review"],
    });

    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice.label).not.toContain("-");
      expect(notice.label.length).toBeGreaterThan(10);
    }
  });

  it("orders notices by the domain's gate list, so one Project always reads the same way", () => {
    const forward = contentProjectGateNotices({
      ready: false,
      missingGates: ["evidence-review", "brand-voice"],
    });
    const reversed = contentProjectGateNotices({
      ready: false,
      missingGates: ["brand-voice", "evidence-review"],
    });

    expect(forward.map((notice) => notice.gate)).toEqual(reversed.map((notice) => notice.gate));
    expect(forward.map((notice) => notice.gate)).toEqual(["brand-voice", "evidence-review"]);
  });

  it("points the gates that are fixed elsewhere at where they are fixed", () => {
    const notices = contentProjectGateNotices({
      ready: false,
      missingGates: ["canonical-owner", "brand-voice"],
    });

    expect(notices.find((notice) => notice.gate === "canonical-owner")?.href).toBe("/settings");
    expect(notices.find((notice) => notice.gate === "brand-voice")?.href).toBe("/content-scout");
  });

  /* The reason this is derived from CONTENT_PROJECT_GATES rather than a list
     kept by hand: a gate added to the domain must not render as nothing. */
  it("renders every gate the domain defines", () => {
    const notices = contentProjectGateNotices({
      ready: false,
      missingGates: [...CONTENT_PROJECT_GATES],
    });

    expect(notices).toHaveLength(CONTENT_PROJECT_GATES.length);
    for (const notice of notices) {
      expect(notice.label.trim()).not.toBe("");
    }
  });
});

describe("Content Project readiness label", () => {
  it("reads as ready when it is", () => {
    expect(contentProjectReadinessLabel({ ready: true, missingGates: [] })).toBe(
      "Ready to generate",
    );
  });

  it("counts what is left, singular and plural", () => {
    expect(contentProjectReadinessLabel({ ready: false, missingGates: ["target"] })).toBe(
      "1 gate to clear",
    );
    expect(
      contentProjectReadinessLabel({ ready: false, missingGates: ["target", "brand-voice"] }),
    ).toBe("2 gates to clear");
  });
});
