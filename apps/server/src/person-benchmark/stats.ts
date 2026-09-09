/**
 * The statistics of small-n arm comparison (pain: run-to-run variance swamps
 * model differences). Closed-form normal-approximation methods from Evan
 * Miller, "Adding Error Bars to Evals" (arXiv:2411.00640): the SE of an arm
 * mean comes from the across-person sample SD (Bessel-corrected), comparisons
 * ride the per-person paired differences so correlated difficulty shrinks the
 * bar, and the minimum detectable effect names the bar before anyone reads a
 * winner off two noisy arms.
 *
 * Absent measurements stay absent: every aggregate returns null when its
 * denominator does not exist (fewer than two observations), never a zero that
 * would read as a measured, tight interval.
 */

/** The power z for 80% power plus the two-sided 5% significance z: 2.8016. */
const MDE_FACTOR = 1.959964 + 0.841621;

/** The 95% normal half-width multiplier. */
const Z95 = 1.959964;

/** One Benchmark Person's recovery fraction, once per repeat of the arm. */
export interface PersonScores {
  slug: string;
  scores: number[];
}

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample SD with Bessel's correction; 0 for a single value. */
export function sampleSD(values: number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mu) ** 2, 0) / (values.length - 1));
}

export function personMean(person: PersonScores): number {
  return mean(person.scores);
}

/**
 * The arm's mean over per-person means, with its 95% normal interval. The SE
 * spans persons — the sampling unit — never pooled across repeats, which
 * would pretend K·n correlated samples were independent (arXiv:2411.00640
 * §2.4). Null below two persons.
 */
export function armCI(
  personMeans: number[],
): { mean: number; se: number; lo: number; hi: number } | null {
  if (personMeans.length < 2) return null;
  const mu = mean(personMeans);
  const se = sampleSD(personMeans) / Math.sqrt(personMeans.length);
  const halfWidth = Z95 * se;
  return { mean: mu, se, lo: mu - halfWidth, hi: mu + halfWidth };
}

export interface PairedDifference {
  diffs: number[];
  mean: number;
  sd: number;
  se: number;
  /** mean / se; the noise question is |z| < 2. */
  z: number;
  /** Pearson correlation of the two arms across people; null when either side
   *  has zero spread, so the reduction's variance gain is not claimable. */
  corr: number | null;
}

/**
 * Per-person paired differences between two arms over the same people, in the
 * same order. Agreement on which people are hard drops the bar by 2·Cov/n —
 * free variance reduction over comparing arm totals (arXiv:2411.00640 §2.2).
 */
export function pairedDifferences(a: number[], b: number[]): PairedDifference | null {
  if (a.length !== b.length || a.length < 2) return null;
  const diffs = a.map((value, index) => value - b[index]!);
  const mu = mean(diffs);
  const sd = sampleSD(diffs);
  const se = sd / Math.sqrt(diffs.length);
  const sdA = sampleSD(a);
  const sdB = sampleSD(b);
  let corr: number | null = null;
  if (sdA > 0 && sdB > 0) {
    const muA = mean(a);
    const muB = mean(b);
    const covariance =
      a.reduce((sum, value, index) => sum + (value - muA) * (b[index]! - muB), 0) / (a.length - 1);
    corr = covariance / (sdA * sdB);
  }
  return { diffs, mean: mu, sd, se, z: mu / se, corr };
}

/**
 * The smallest true paired difference this design can distinguish at 80%
 * power and 5% significance: 2.8016·sd(d)/√n (arXiv:2411.00640 §2.3). Null
 * below two people. Read before running: an expected effect under the MDE
 * means the question, not the model, needs to change.
 */
export function mde(sd: number, n: number): number | null {
  if (n < 2) return null;
  return (MDE_FACTOR * sd) / Math.sqrt(n);
}
