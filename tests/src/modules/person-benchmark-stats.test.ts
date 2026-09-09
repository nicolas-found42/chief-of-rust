import { describe, expect, it } from "vitest";
import {
  armCI,
  mde,
  pairedDifferences,
  personMean,
  type PersonScores,
} from "../../../apps/server/src/person-benchmark/stats.js";

/* Worked examples computed by hand (Bessel-corrected sd, normal z = 1.959964,
   power z = 0.841621): the stats module's independent source of truth. */

describe("armCI", () => {
  it("returns null for a single score, where no across-person SE exists", () => {
    expect(armCI([0.5])).toBeNull();
  });

  it("degenerates to the mean itself when every person scored identically", () => {
    expect(armCI([0.5, 0.5, 0.5, 0.5])).toEqual({ mean: 0.5, se: 0, lo: 0.5, hi: 0.5 });
  });

  it("computes mean ± 1.96·sd/√n on a worked example", () => {
    // sd([1,2,3,4]) = 1.29099, se = 0.6455, half-width = 1.26518
    const ci = armCI([1, 2, 3, 4])!;
    expect(ci.mean).toBe(2.5);
    expect(ci.se).toBeCloseTo(0.6454972, 6);
    expect(ci.lo).toBeCloseTo(1.2348487, 6);
    expect(ci.hi).toBeCloseTo(3.7651513, 6);
  });
});

describe("personMean", () => {
  it("averages the repeat scores of one person", () => {
    const person: PersonScores = { slug: "ana-botin", scores: [0.2, 0.4, 0.6] };
    expect(personMean(person)).toBeCloseTo(0.4, 10);
  });
});

describe("pairedDifferences", () => {
  it("returns null when fewer than two people are shared", () => {
    expect(pairedDifferences([0.5], [0.4])).toBeNull();
  });

  it("computes the paired mean, sd, se and z on a worked example", () => {
    // diffs of [0.5,0.5,0.5,0.5] − [0.4,0.5,0.6,0.4]: mean 0.025, sd 0.095743, se 0.047871, z 0.52223
    const paired = pairedDifferences([0.5, 0.5, 0.5, 0.5], [0.4, 0.5, 0.6, 0.4])!;
    expect(paired.diffs.length).toBe(4);
    for (const [actual, expected] of [
      [paired.diffs[0], 0.1],
      [paired.diffs[1], 0],
      [paired.diffs[2], -0.1],
      [paired.diffs[3], 0.1],
    ])
      expect(actual).toBeCloseTo(expected, 10);
    expect(paired.sd).toBeCloseTo(0.095743, 5);
    expect(paired.se).toBeCloseTo(0.047871, 5);
    expect(paired.z).toBeCloseTo(0.52223, 4);
  });

  it("reports no correlation when either side has zero spread", () => {
    const paired = pairedDifferences([0.5, 0.5, 0.5, 0.5], [0.4, 0.5, 0.6, 0.4])!;
    expect(paired.corr).toBeNull();
  });

  it("computes Pearson correlation on a spread-out worked example", () => {
    // r([1..5],[2,4,5,4,5]) = 6/(√10·√6) = 0.774597
    const paired = pairedDifferences([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])!;
    expect(paired.corr).toBeCloseTo(0.774597, 5);
  });
});

describe("mde", () => {
  it("returns null for a single observation", () => {
    expect(mde(1, 1)).toBeNull();
  });

  it("is 2.8016·sd/√n at 80% power and 5% significance", () => {
    // 2.801585 · 1.29099 / 2
    expect(mde(1.29099, 4)).toBeCloseTo(1.8084091, 6);
    // The n=30 planning number from the research note: sd 0.6 → ~0.31
    expect(mde(0.6, 30)).toBeCloseTo(0.3068983, 6);
  });
});
