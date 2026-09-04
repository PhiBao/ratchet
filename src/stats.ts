/**
 * Small honest-math helpers for the walk-forward proof. No dependencies.
 *
 * Fisher's exact test answers the question judges actually ask about a
 * win-rate table ("6/12 vs 8/11 — is that signal or noise?"). The activity
 * verdict answers the sibling question ("did evolution just learn to never
 * trade?"). Both are computed from the same frozen/evolved counts the harness
 * already prints, so they can never disagree with the table.
 */

/** log(n!) by summation — exact enough for the sample sizes here. */
function logFact(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

function logComb(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  return logFact(n) - logFact(k) - logFact(n - k);
}

/**
 * Two-sided Fisher exact p for [[a,b],[c,d]] (e.g. evolved win/loss vs frozen
 * win/loss), summing hypergeometric probabilities no larger than the observed
 * table's. Returns 1 when either row is empty — with no trades there is no
 * evidence either way, and saying so beats printing p=0 or NaN.
 */
export function fisherTwoSided(a: number, b: number, c: number, d: number): number {
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const n = row1 + row2;
  if (row1 === 0 || row2 === 0) return 1;
  const logPObs = logComb(row1, a) + logComb(row2, c) - logComb(n, col1);
  let p = 0;
  const lo = Math.max(0, col1 - row2);
  const hi = Math.min(row1, col1);
  for (let i = lo; i <= hi; i++) {
    const lp = logComb(row1, i) + logComb(row2, col1 - i) - logComb(n, col1);
    if (lp <= logPObs + 1e-12) p += Math.exp(lp);
  }
  return Math.min(1, Math.max(0, p));
}

export type ActivityVerdict = "ok" | "thin" | "degenerate" | "empty";

/**
 * Guards the ratchet's terminal failure mode: an evolution that trades almost
 * nothing has not learned discipline, it has learned silence.
 * - empty: neither baseline traded — the experiment contains no evidence at
 *   all and cannot support any claim in either direction.
 * - degenerate: evolved took zero trades while frozen traded — the loop
 *   produced a shutdown, not a strategy.
 * - thin: either side starved (fewer than 3 trades) — too little activity to
 *   claim anything about decision quality.
 */
export function activityVerdict(frozenTrades: number, evolvedTrades: number): ActivityVerdict {
  if (frozenTrades === 0 && evolvedTrades === 0) return "empty";
  if (evolvedTrades === 0 && frozenTrades > 0) return "degenerate";
  if (frozenTrades < 3 || evolvedTrades < 3) return "thin";
  return "ok";
}
