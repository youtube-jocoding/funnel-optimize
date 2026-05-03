#!/usr/bin/env node

/**
 * Render a self-contained funnel dashboard HTML from .funnel-state snapshots.
 *
 * Usage:
 *   node scripts/render-dashboard.mjs [--root <path>] [--out <path>]
 *
 * Output: docs/funnel-archive/dashboard.html
 */

// ─── pValueTwoProp ────────────────────────────────────────────────────────
//
// Two-proportion z-test → two-tailed p-value.
// Returns null when either sample size is below the heuristic minimum (30)
// or when totals are zero, so callers can show a "sample too small" badge
// instead of a misleading number.

export function pValueTwoProp(c1, n1, c2, n2) {
  if (n1 <= 0 || n2 <= 0) return null;
  if (n1 < 30 || n2 < 30) return null;

  const p1 = c1 / n1;
  const p2 = c2 / n2;
  const pPool = (c1 + c2) / (n1 + n2);
  const denom = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (denom === 0) {
    // Both proportions are 0 (or both 1) — z-test undefined; treat as p=1.
    return { p: 1, z: 0 };
  }

  const z = (p2 - p1) / denom;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { p, z };
}

// Abramowitz & Stegun 26.2.17 approximation of the standard normal CDF.
function normalCdf(x) {
  const b1 =  0.319381530;
  const b2 = -0.356563782;
  const b3 =  1.781477937;
  const b4 = -1.821255978;
  const b5 =  1.330274429;
  const p  =  0.2316419;
  const c  =  0.39894228;

  if (x >= 0) {
    const t = 1.0 / (1.0 + p * x);
    return 1.0 - c * Math.exp(-x * x / 2.0) *
      t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1);
  } else {
    return 1.0 - normalCdf(-x);
  }
}
