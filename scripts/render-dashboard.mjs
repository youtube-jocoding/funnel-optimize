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

// ─── buildTrendModel ─────────────────────────────────────────────────────
//
// Recompute the funnel for each historical snapshot so the trend chart
// can plot how cumulative conversion rates evolved week over week.

export function buildTrendModel(config, history) {
  const cap = config?.dashboard?.trend_weeks ?? 8;
  if (!Array.isArray(history) || history.length < 2) {
    return { available: false, weeks: [] };
  }

  const recent = history.slice(-cap);
  const weeks = recent.map((snap) => ({
    periodEnd: snap?.meta?.period_end ?? null,
    steps: buildFunnelModel(config, snap),
  }));

  return { available: true, weeks };
}

// ─── buildExperimentModel ────────────────────────────────────────────────
//
// Groups `snapshot.experiment_variants.results` rows ([variant, event,
// count, users]) into per-variant funnels along config.funnel.steps.
// Computes lift per step (test/control - 1). Picks the p-value from the
// evaluation file when available, otherwise computes one at the purchase
// step. Returns null when there's no variant data.

export function buildExperimentModel(config, snapshot, evaluation, plan) {
  const rows = snapshot?.experiment_variants?.results;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const steps = config?.funnel?.steps || [];
  if (steps.length === 0) return null;

  // Group: variant → event → users
  const byVariant = new Map();
  for (const [variant, event, _cnt, users] of rows) {
    if (!byVariant.has(variant)) byVariant.set(variant, new Map());
    byVariant.get(variant).set(event, users);
  }

  const variants = Array.from(byVariant.keys());
  const controlKey = pickVariant(variants, ['control', 'false', 'baseline']);
  const testKey = variants.find((v) => v !== controlKey) ?? null;
  if (!controlKey || !testKey) return null;

  const purchaseStep = detectPurchaseStep(config);

  const buildVariantFunnel = (variantKey) => {
    const m = byVariant.get(variantKey) || new Map();
    // Use the first funnel step that actually has data for this variant as
    // the baseline. Variants typically lack pageview-level rows in PostHog
    // experiment exports.
    let firstUsers = 0;
    for (const s of steps) {
      const u = m.get(s) ?? 0;
      if (u > 0) { firstUsers = u; break; }
    }
    const out = [];
    let prevUsers = null;
    for (const s of steps) {
      const users = m.get(s) ?? 0;
      const rateFromFirst = firstUsers > 0 ? users / firstUsers : null;
      out.push({
        name: s,
        users,
        rateFromFirst,
        dropFromPrev: prevUsers === null ? null : users - prevUsers,
        isPurchase: s === purchaseStep,
      });
      prevUsers = users;
    }
    return out;
  };

  const control = buildVariantFunnel(controlKey);
  const test = buildVariantFunnel(testKey);

  const lift = steps.map((s) => {
    const c = control.find((x) => x.name === s);
    const t = test.find((x) => x.name === s);
    const controlRate = c?.rateFromFirst ?? 0;
    const testRate = t?.rateFromFirst ?? 0;
    let liftVal = null;
    if (controlRate === 0 && testRate === 0) liftVal = 0;
    else if (controlRate === 0) liftVal = Infinity;
    else liftVal = (testRate - controlRate) / controlRate;
    return { name: s, controlRate, testRate, lift: liftVal };
  });

  // p-value at the purchase step.
  let pValue = evaluation?.p_value ?? null;
  if (pValue === null && purchaseStep) {
    // Use first-step-with-data per variant as the n.
    const cMap = byVariant.get(controlKey);
    const tMap = byVariant.get(testKey);
    let cN = 0, tN = 0;
    for (const s of steps) {
      const u = cMap?.get(s) ?? 0;
      if (u > 0) { cN = u; break; }
    }
    for (const s of steps) {
      const u = tMap?.get(s) ?? 0;
      if (u > 0) { tN = u; break; }
    }
    const cPaid = cMap?.get(purchaseStep) ?? 0;
    const tPaid = tMap?.get(purchaseStep) ?? 0;
    const r = pValueTwoProp(cPaid, cN, tPaid, tN);
    pValue = r ? r.p : null;
  }

  return {
    name: plan?.experiment_name ?? evaluation?.experiment ?? null,
    flagKey: plan?.flag_key ?? evaluation?.flag_key ?? null,
    decision: evaluation?.decision?.action ?? null,
    decisionReason: evaluation?.decision?.reason ?? null,
    pValue,
    controlKey,
    testKey,
    control,
    test,
    lift,
    purchaseStep,
  };
}

function pickVariant(variants, preferred) {
  for (const want of preferred) {
    const hit = variants.find((v) => String(v).toLowerCase() === want);
    if (hit) return hit;
  }
  return variants[0] ?? null;
}

// ─── Formatting helpers ──────────────────────────────────────────────────

export function formatNumber(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

export function formatPct(fraction) {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(fraction < 0.01 ? 2 : 1)}%`;
}

export function formatRate(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${Number(pct).toFixed(pct < 1 ? 2 : 1)}%`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function formatLift(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  const sign = x >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(x) * 100).toFixed(1)}%`;
}

export function formatPValue(p) {
  if (p == null || !Number.isFinite(p)) return 'sample too small for inference';
  const significant = p < 0.05;
  return `p=${p.toFixed(3)} — ${significant ? 'significant' : 'not significant'}`;
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
