#!/usr/bin/env node

/**
 * Render a self-contained funnel dashboard HTML from .funnel-state snapshots.
 *
 * Usage:
 *   node scripts/render-dashboard.mjs [--root <path>] [--out <path>]
 *
 * Output: docs/funnel-archive/dashboard.html
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

// ─── loadInputs ───────────────────────────────────────────────────────────
//
// Reads the inputs needed to render a dashboard. `rootDir` defaults to the
// current working directory so the CLI just works; tests pass a temp dir.

export function loadInputs(rootDir = process.cwd()) {
  const configPath = join(rootDir, 'funnel-config.json');
  const stateDir = join(rootDir, '.funnel-state');
  const latestPath = join(stateDir, 'latest-snapshot.json');

  if (!existsSync(latestPath)) {
    throw new Error(
      `No snapshot found at ${latestPath}. ` +
      `Run 'npm run collect' first to produce a weekly snapshot, ` +
      `then re-run the dashboard.`,
    );
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const snapshot = JSON.parse(readFileSync(latestPath, 'utf-8'));

  // stateDir is guaranteed to exist by the latestPath check above.
  // Filter to ISO-dated weekly snapshots; lexicographic sort = chronological.
  const history = readdirSync(stateDir)
    .filter((f) => /^weekly-snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(stateDir, f), 'utf-8')));

  const state = readJsonOrNull(join(stateDir, 'state.json'));
  const evaluation = readJsonOrNull(join(stateDir, 'evaluation-result.json'));
  const plan = readJsonOrNull(join(stateDir, 'experiment-plan.json'));

  return { config, snapshot, history, state, evaluation, plan };
}

function readJsonOrNull(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch { return null; }
}

// ─── detectPurchaseStep ──────────────────────────────────────────────────
//
// Heuristic: highest-priority "P0/higher" optimization target whose
// click_events intersect funnel.steps. Allows explicit override.

export function detectPurchaseStep(config) {
  const steps = config?.funnel?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const override = config?.dashboard?.purchase_step_override;
  if (override && steps.includes(override)) return override;

  const targets = config?.optimization_targets || [];
  for (const t of targets) {
    if (t.priority !== 'P0' || t.direction !== 'higher') continue;
    for (const ev of t.click_events || []) {
      if (steps.includes(ev)) return ev;
    }
  }

  return steps[steps.length - 1];
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
