import { describe, expect, it } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import {
  PERSON_SOURCE_FAMILIES,
  type PersonProfile,
  type PersonSourceFamily,
} from "@chief-of-staff-demo/shared";
import {
  buildCoveragePlan,
  deriveLeads,
  seedQueries,
} from "../../../apps/server/src/person-profile/research-plan.js";

/**
 * A profession hypothesis orders work; it must never exclude other
 * industries, languages, roles or source families (#252). A registry hit for
 * one obvious professional register is one more query alongside the general
 * ones, never a substitute for them.
 */
describe("the coverage plan and seed queries stay neutral about profession", () => {
  it("plans every non-workspace source family regardless of what the Profile suggests about industry", () => {
    const plan = buildCoveragePlan();
    const familyKeys = plan
      .filter((area) => area.kind === "source-family")
      .map((area) => area.key)
      .sort();
    const expected = Object.keys(PERSON_SOURCE_FAMILIES)
      .filter((key) => key !== "workspace")
      .sort();
    expect(familyKeys).toEqual(expected);
    expect(plan.every((area) => area.state === "planned")).toBe(true);
  });

  it("adds a registry-shaped seed for an apparently professional employer without dropping the general ones", () => {
    const profile: PersonProfile = fromPartial({
      fullName: "Maya Chen",
      currentEmployer: "Atlas General Hospital",
      employerHints: [],
      emails: [],
    });
    const seeds = seedQueries(profile);
    /* The professional-looking employer earns its own query; it does not
       narrow the seed set down to it. */
    expect(seeds).toContainEqual(expect.stringContaining("publication OR filing OR registry"));
    expect(seeds).toContainEqual(expect.stringContaining("interview OR podcast OR talk"));
    expect(seeds).toContainEqual(expect.stringContaining("profile OR announcement OR appointment"));
    expect(seeds).toContainEqual(expect.stringContaining("biography role career"));
  });

  it("derives a query for every unsatisfied source family, not only the one a profession guess would favor", () => {
    const unsatisfied = Object.keys(PERSON_SOURCE_FAMILIES)
      .filter((key) => key !== "workspace")
      .map((key) => ({
        key,
        label: key,
        kind: "source-family" as const,
        state: "planned" as const,
        sources: 0,
        claims: 0,
        gaps: [],
      }));
    const profile: PersonProfile = fromPartial({
      fullName: "Maya Chen",
      currentEmployer: "Atlas General Hospital",
    });
    const { queries } = deriveLeads(profile, null, unsatisfied);
    const targetedFamilies = new Set(queries.map((query) => query.family));
    /* Every family that has a deterministic query template gets one; a
       professional guess is not a reason a video, social or creative-records
       gap goes untargeted. */
    const expectedFamilies: PersonSourceFamily[] = [
      "spoken-evidence",
      "public-social",
      "published-work",
      "professional-records",
      "creative-records",
      "identity-affiliation",
      "historical-evidence",
      "documents-publishers",
    ];
    for (const family of expectedFamilies) expect(targetedFamilies.has(family)).toBe(true);
  });
});
