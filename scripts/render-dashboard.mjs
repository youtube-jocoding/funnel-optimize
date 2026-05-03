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

// ─── buildFunnelModel ────────────────────────────────────────────────────
//
// Walks config.funnel.steps in order. For each step, looks up the user
// count from snapshot.funnel.results (rows of [step, users]) and computes:
//   - rateFromFirst   : users / users(first step), null if first is 0
//   - dropFromPrev    : users - prevUsers, null for the first step
//   - dropPctFromPrev : dropFromPrev / prevUsers, null for first or prev=0
// Attaches a KPI summary when the step name appears in any
// optimization_target's click_events.

export function buildFunnelModel(config, snapshot) {
  const steps = config?.funnel?.steps || [];
  const rows = snapshot?.funnel?.results || [];
  const userByStep = Object.fromEntries(rows);
  const purchaseStep = detectPurchaseStep(config);

  const targetByEvent = new Map();
  for (const t of config?.optimization_targets || []) {
    for (const ev of t.click_events || []) {
      if (!targetByEvent.has(ev)) targetByEvent.set(ev, t);
    }
  }

  const kpiByName = snapshot?.kpi || {};
  const firstUsers = userByStep[steps[0]] ?? 0;

  const out = [];
  let prevUsers = null;
  for (const step of steps) {
    const users = userByStep[step] ?? 0;
    const missing = !(step in userByStep);
    const rateFromFirst = firstUsers > 0 ? users / firstUsers : null;
    const dropFromPrev = prevUsers === null ? null : users - prevUsers;
    const dropPctFromPrev = prevUsers === null || prevUsers === 0
      ? null
      : (users - prevUsers) / prevUsers;

    const target = targetByEvent.get(step);
    let kpi = null;
    if (target) {
      const k = kpiByName[target.kpi];
      if (k) {
        kpi = {
          metric_name: target.metric_name,
          ctr: k.ctr,
          target_ctr: k.target_ctr ?? target.target,
          gap: k.gap ?? null,
          status: statusForKpi(k.ctr, k.target_ctr ?? target.target),
        };
      }
    }

    out.push({
      name: step,
      users,
      missing,
      rateFromFirst,
      dropFromPrev,
      dropPctFromPrev,
      isPurchase: step === purchaseStep,
      kpi,
    });
    prevUsers = users;
  }

  return out;
}

// ─── statusForKpi ────────────────────────────────────────────────────────
//
// Returns one of 'pass' | 'up' | 'miss' | 'na'.
//   pass : current >= target
//   up   : current > 0 and within reach (>=50% of target)
//   miss : current < target and below "up" threshold
//   na   : either side missing

export function statusForKpi(current, target) {
  if (current == null || target == null || target === 0) return 'na';
  if (current >= target) return 'pass';
  if (current >= target * 0.5) return 'up';
  return 'miss';
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
