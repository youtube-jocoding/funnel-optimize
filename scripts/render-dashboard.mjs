#!/usr/bin/env node

/**
 * Render a self-contained funnel dashboard HTML from .funnel-state snapshots.
 *
 * Usage:
 *   node scripts/render-dashboard.mjs [--root <path>] [--out <path>]
 *
 * Output: docs/funnel-archive/dashboard.html
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ─── renderHTML ──────────────────────────────────────────────────────────
//
// Pure: takes models in, returns a full HTML document string.
// All CSS / JS / SVG / data is inlined. No external requests.

export function renderHTML({ config, funnel, trend, experiment, history, meta, kpiByName }) {
  const projectName = escapeHtml(config?.project?.name ?? 'Funnel Optimize');
  const periodEnd = escapeHtml(meta?.period_end ?? '');
  const periodDays = Number(meta?.period_days ?? 7);
  const trendWeeksCount = Number(trend?.weeks?.length ?? 0);
  const purchaseStep = detectPurchaseStep(config) ?? '';

  // Pre-build KPI tiles server-side so the client doesn't have to do fragile
  // matching: each entry has the metric name, current %, target %, status.
  const kpiTiles = (config?.optimization_targets ?? []).map((t) => {
    const current = kpiByName?.[t.kpi]?.ctr ?? null;
    return {
      priority: t.priority ?? null,
      metric_name: t.metric_name ?? t.kpi,
      current,
      target: t.target ?? null,
      status: statusForKpi(current, t.target),
    };
  });

  const data = JSON.stringify({
    project: config?.project ?? {},
    purchaseStep,
    funnel,
    trend,
    experiment,
    history: history ?? [],
    meta: meta ?? {},
    kpiTiles,
    defaultScale: config?.dashboard?.default_scale ?? 'auto',
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${projectName} — Funnel Dashboard (${periodEnd})</title>
<style>${CSS}</style>
</head>
<body>
<header class="hd">
  <div class="hd-row">
    <div class="hd-title">
      <span class="hd-eyebrow">Funnel Optimize</span>
      <h1>${projectName}</h1>
    </div>
    <div class="hd-meta">
      <span>Window</span>
      <strong>${periodEnd} · ${periodDays} days</strong>
    </div>
  </div>
  <div id="kpi-tiles" class="kpi-tiles" aria-label="KPI tiles"></div>
</header>

<main>
  <section class="card" id="funnel-trend" ${trend?.available ? '' : 'data-empty="true"'}>
    <header class="card-h">
      <h2>Trend — last ${trendWeeksCount} weeks</h2>
      <p class="muted">Cumulative conversion from first step. Up = improvement.</p>
    </header>
    <div class="card-body" id="trend-body">
      ${trend?.available ? '' : '<p class="empty-msg">Run for 2+ weeks to see trends.</p>'}
    </div>
  </section>

  <section class="card" id="funnel-current">
    <header class="card-h">
      <h2>Current funnel — ${periodEnd}</h2>
      <div class="scale-toggle" role="group" aria-label="Bar scale">
        <button data-scale="linear">Linear</button>
        <button data-scale="log">Log</button>
      </div>
    </header>
    <div class="card-body" id="funnel-body"></div>
  </section>

  <section class="card" id="funnel-experiment" ${experiment ? '' : 'data-empty="true"'}>
    <header class="card-h">
      <h2>Active experiment</h2>
      <p class="muted" id="exp-headline"></p>
    </header>
    <div class="card-body" id="exp-body">
      ${experiment ? '' : '<p class="empty-msg">No active experiment.</p>'}
    </div>
  </section>

  <section class="card" id="history-card">
    <header class="card-h"><h2>Experiment history</h2></header>
    <div class="card-body" id="history-body"></div>
  </section>
</main>

<footer class="ft">
  <span>Generated by funnel-optimize · ${escapeHtml(new Date().toISOString().slice(0, 10))}</span>
</footer>

<script type="application/json" id="data">${data.replace(/</g, '\\u003c')}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}

const CSS = `
:root {
  --fg: #0f172a; --muted: #64748b; --bg: #ffffff; --panel: #f8fafc;
  --border: #e2e8f0; --accent: #2563eb; --good: #16a34a; --warn: #d97706;
  --bad: #dc2626; --bar: #cbd5e1; --bar-hl: #2563eb;
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); }
.hd { padding: 28px 32px 12px; border-bottom: 1px solid var(--border); }
.hd-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
.hd-eyebrow { text-transform: uppercase; font-size: 11px; letter-spacing: .12em; color: var(--muted); }
.hd-title h1 { margin: 4px 0 0; font-size: 22px; font-weight: 600; }
.hd-meta { text-align: right; color: var(--muted); }
.hd-meta strong { color: var(--fg); display: block; margin-top: 2px; }
.kpi-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 18px; }
.tile { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.tile h3 { margin: 0 0 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
.tile .v { font-size: 22px; font-weight: 600; }
.tile .t { color: var(--muted); font-size: 12px; margin-top: 4px; }
.tile .delta-up { color: var(--good); }
.tile .delta-down { color: var(--bad); }
main { padding: 24px 32px 48px; display: grid; gap: 20px; max-width: 1280px; margin: 0 auto; }
.card { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; }
.card[data-empty="true"] .card-body { padding: 18px 20px; }
.card-h { padding: 16px 20px 0; display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
.card-h h2 { font-size: 14px; font-weight: 600; margin: 0; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.card-h p.muted { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.card-body { padding: 12px 20px 20px; }
.empty-msg { color: var(--muted); font-style: italic; }
.scale-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.scale-toggle button { background: var(--bg); border: 0; padding: 4px 10px; font: inherit; color: var(--muted); cursor: pointer; }
.scale-toggle button.active { background: var(--accent); color: #fff; }
.row { display: grid; grid-template-columns: 180px 1fr 110px 100px; gap: 12px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); }
.row:first-child { border-top: 0; }
.row.purchase { background: linear-gradient(90deg, rgba(37,99,235,0.05), transparent); }
.row .name { font-weight: 600; }
.row .name .sub { display: block; color: var(--muted); font-weight: 400; font-size: 12px; }
.row .bar { background: var(--panel); border-radius: 6px; height: 22px; position: relative; overflow: hidden; border: 1px solid var(--border); }
.row .bar .fill { height: 100%; background: var(--bar); border-radius: 6px; transition: width .25s ease; }
.row.purchase .bar .fill { background: var(--bar-hl); }
.row .bar .label { position: absolute; inset: 0; display: flex; align-items: center; padding: 0 8px; font-size: 12px; color: var(--fg); }
.row .num { text-align: right; font-variant-numeric: tabular-nums; }
.row .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.pill.pass { background: #dcfce7; color: var(--good); }
.pill.up { background: #fef3c7; color: var(--warn); }
.pill.miss { background: #fee2e2; color: var(--bad); }
.pill.na { background: var(--panel); color: var(--muted); }
.drop { padding: 0 12px 8px 192px; color: var(--muted); font-size: 12px; }
.drop b { color: var(--bad); }
.exp-grid { display: grid; grid-template-columns: 1fr 110px 1fr; gap: 16px; align-items: center; }
.exp-side h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.exp-lift { text-align: center; font-weight: 600; }
.exp-lift.pos { color: var(--good); }
.exp-lift.neg { color: var(--bad); }
.exp-foot { margin-top: 16px; padding: 12px 14px; background: var(--panel); border-radius: 8px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; color: var(--muted); }
.exp-foot strong { color: var(--fg); }
.history-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.history-table th, .history-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.history-table th { font-weight: 600; color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: .08em; }
.trend-svg { width: 100%; height: 220px; }
.trend-svg .line { fill: none; stroke: var(--accent); stroke-width: 2; }
.trend-svg .grid { stroke: var(--border); stroke-width: 1; }
.trend-svg .pt { fill: var(--accent); }
.trend-svg .ax { fill: var(--muted); font-size: 11px; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; margin: 8px 0 4px; font-size: 12px; color: var(--muted); }
.legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: middle; margin-right: 4px; }
.ft { padding: 16px 32px; color: var(--muted); border-top: 1px solid var(--border); font-size: 12px; text-align: center; }
@media (max-width: 720px) {
  .row { grid-template-columns: 1fr 110px 90px; }
  .row .bar { display: none; }
  .drop { padding-left: 12px; }
  .exp-grid { grid-template-columns: 1fr; }
}
`;

const CLIENT_JS = `
(function () {
  const data = JSON.parse(document.getElementById('data').textContent);
  const fmtN = (n) => n == null ? '—' : Number(n).toLocaleString('en-US');
  const fmtPct = (f) => f == null || !isFinite(f) ? '—' : ((f * 100).toFixed(f < 0.01 ? 2 : 1) + '%');
  const fmtRate = (p) => p == null || !isFinite(p) ? '—' : (Number(p).toFixed(p < 1 ? 2 : 1) + '%');
  const fmtLift = (x) => x == null || !isFinite(x) ? '—' : ((x >= 0 ? '+' : '-') + (Math.abs(x) * 100).toFixed(1) + '%');

  // ── KPI tiles ──
  const tiles = document.getElementById('kpi-tiles');
  const ns = data.project.north_star;
  if (ns) {
    tiles.appendChild(tile('North Star', ns.metric ?? '—', ns.target ?? ''));
  }
  for (const t of (data.kpiTiles || []).slice(0, 4)) {
    tiles.appendChild(tile(
      (t.priority ? t.priority + ' · ' : '') + t.metric_name,
      fmtRate(t.current),
      'target ' + fmtRate(t.target),
    ));
  }

  function tile(title, value, sub) {
    const el = document.createElement('div'); el.className = 'tile';
    el.innerHTML = '<h3>' + esc(title) + '</h3><div class="v">' + esc(value) + '</div>' + (sub ? '<div class="t">' + esc(sub) + '</div>' : '');
    return el;
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ── Current funnel bars ──
  const body = document.getElementById('funnel-body');
  const maxUsers = Math.max(...data.funnel.map((s) => s.users || 0), 1);
  const minNonZero = Math.max(1, Math.min(...data.funnel.filter((s) => s.users > 0).map((s) => s.users)));
  const autoScale = (data.defaultScale === 'auto')
    ? (minNonZero / maxUsers < 0.01 ? 'log' : 'linear')
    : data.defaultScale;
  let scale = autoScale;
  for (const btn of document.querySelectorAll('.scale-toggle button')) {
    btn.classList.toggle('active', btn.dataset.scale === scale);
    btn.addEventListener('click', () => { scale = btn.dataset.scale; renderFunnel(); for (const b of document.querySelectorAll('.scale-toggle button')) b.classList.toggle('active', b.dataset.scale === scale); });
  }
  function renderFunnel() {
    body.innerHTML = '';
    let prev = null;
    for (const s of data.funnel) {
      const w = barWidth(s.users, maxUsers, scale);
      const row = document.createElement('div');
      row.className = 'row' + (s.isPurchase ? ' purchase' : '');
      row.innerHTML =
        '<div class="name">' + esc(prettyName(s.name)) + (s.isPurchase ? '<span class="sub">PURCHASE</span>' : '') + '</div>' +
        '<div class="bar"><div class="fill" style="width:' + w + '%"></div><div class="label">' + esc(prettyName(s.name)) + '</div></div>' +
        '<div class="num">' + fmtN(s.users) + (s.rateFromFirst != null ? '<span class="sub" style="color:var(--muted);font-size:12px;display:block">' + fmtPct(s.rateFromFirst) + '</span>' : '') + '</div>' +
        '<div>' + (s.kpi ? pill(s.kpi.status, fmtRate(s.kpi.ctr) + ' / ' + fmtRate(s.kpi.target_ctr)) : (s.missing ? '<span class="pill na">no events</span>' : '')) + '</div>';
      body.appendChild(row);
      if (prev) {
        const drop = document.createElement('div');
        drop.className = 'drop';
        if (prev.users > 0) {
          drop.innerHTML = '▼ <b>' + fmtN(s.users - prev.users) + '</b> users · ' + fmtLift((s.users - prev.users) / prev.users);
        } else {
          drop.textContent = '▼ —';
        }
        body.insertBefore(drop, row);
      }
      prev = s;
    }
  }
  function pill(status, txt) { return '<span class="pill ' + status + '">' + esc(txt) + '</span>'; }
  function prettyName(s) { return s === '$pageview' ? 'Page view' : s.replace(/_/g, ' '); }
  function barWidth(users, max, scale) {
    if (!users || max <= 0) return 0;
    if (scale === 'log') {
      const lo = Math.log10(0.5);
      const hi = Math.log10(max);
      return Math.max(2, ((Math.log10(users) - lo) / (hi - lo)) * 100);
    }
    return Math.max(0.5, (users / max) * 100);
  }
  renderFunnel();

  // ── Trend chart ──
  if (data.trend && data.trend.available) {
    const tb = document.getElementById('trend-body');
    const W = 880, H = 220, padL = 36, padR = 16, padT = 16, padB = 28;
    // Pull cumulative rates per step across weeks.
    const stepNames = data.funnel.map((s) => s.name);
    const colors = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
    const series = stepNames.slice(1).map((name, i) => ({
      name, color: colors[i % colors.length],
      points: data.trend.weeks.map((w) => {
        const s = w.steps.find((x) => x.name === name);
        return { x: w.periodEnd, y: s?.rateFromFirst ?? null };
      }),
    }));
    const allYs = series.flatMap((s) => s.points.map((p) => p.y).filter((v) => v != null));
    const yMax = Math.max(0.01, Math.max(...allYs));
    const xs = data.trend.weeks.map((w) => w.periodEnd);
    const xPos = (i) => padL + (i / Math.max(1, xs.length - 1)) * (W - padL - padR);
    const yPos = (v) => padT + (1 - v / yMax) * (H - padT - padB);

    const legend = document.createElement('div'); legend.className = 'legend';
    series.forEach((s) => { legend.innerHTML += '<span><span class="dot" style="background:' + s.color + '"></span>' + esc(prettyName(s.name)) + '</span>'; });
    tb.appendChild(legend);

    let svg = '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    // y grid
    for (let g = 0; g <= 4; g++) {
      const y = padT + (g / 4) * (H - padT - padB);
      const v = yMax * (1 - g / 4);
      svg += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '" />';
      svg += '<text class="ax" x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end">' + fmtPct(v) + '</text>';
    }
    // x ticks
    xs.forEach((d, i) => {
      svg += '<text class="ax" x="' + xPos(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(d) + '</text>';
    });
    series.forEach((s) => {
      const path = s.points.map((p, i) => p.y == null ? null : (i === 0 || s.points[i - 1].y == null ? 'M' : 'L') + xPos(i) + ',' + yPos(p.y)).filter(Boolean).join(' ');
      svg += '<path class="line" stroke="' + s.color + '" d="' + path + '" />';
      s.points.forEach((p, i) => { if (p.y != null) svg += '<circle class="pt" cx="' + xPos(i) + '" cy="' + yPos(p.y) + '" r="3" fill="' + s.color + '" />'; });
    });
    svg += '</svg>';
    tb.insertAdjacentHTML('beforeend', svg);
  }

  // ── Active experiment ──
  if (data.experiment) {
    const e = data.experiment;
    document.getElementById('exp-headline').textContent =
      (e.name || 'Experiment') + ' · ' + (e.decision ? 'Decision: ' + e.decision : '');
    const eb = document.getElementById('exp-body');
    const grid = document.createElement('div'); grid.className = 'exp-grid';
    grid.innerHTML = '<div class="exp-side"><h3>Control</h3></div><div></div><div class="exp-side"><h3>Test</h3></div>';
    eb.appendChild(grid);
    for (let i = 0; i < e.control.length; i++) {
      const c = e.control[i], t = e.test[i], l = e.lift[i];
      const cls = l.lift > 0 ? 'pos' : l.lift < 0 ? 'neg' : '';
      grid.insertAdjacentHTML('beforeend',
        '<div class="row" style="grid-template-columns:1fr 100px 80px 1fr;border:0">' +
          '<div>' + esc(prettyName(c.name)) + ' · ' + fmtN(c.users) + '</div>' +
          '<div class="num">' + (c.rateFromFirst != null ? fmtPct(c.rateFromFirst) : '—') + '</div>' +
          '<div class="exp-lift ' + cls + '">' + fmtLift(l.lift) + '</div>' +
          '<div>' + esc(prettyName(t.name)) + ' · ' + fmtN(t.users) + ' · ' + (t.rateFromFirst != null ? fmtPct(t.rateFromFirst) : '—') + '</div>' +
        '</div>'
      );
    }
    const foot = document.createElement('div'); foot.className = 'exp-foot';
    const pTxt = e.pValue == null ? 'sample too small for inference' : ('p=' + e.pValue.toFixed(3) + (e.pValue < 0.05 ? ' — significant' : ' — not significant'));
    foot.innerHTML = '<span><strong>p-value:</strong> ' + esc(pTxt) + '</span>' +
                     '<span><strong>Decision:</strong> ' + esc(e.decision || '—') + '</span>' +
                     '<span><strong>Reason:</strong> ' + esc(e.decisionReason || '—') + '</span>';
    eb.appendChild(foot);
  }

  // ── Experiment history table ──
  if (data.history && data.history.length) {
    const hb = document.getElementById('history-body');
    let html = '<table class="history-table"><thead><tr><th>#</th><th>Experiment</th><th>KPI</th><th>Winner</th><th>Control</th><th>Test</th><th>Days</th></tr></thead><tbody>';
    data.history.forEach((h, i) => {
      const r = h.result || {};
      html += '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(h.experiment_name || '—') + '</td>' +
        '<td>' + esc(h.target_kpi || '—') + '</td>' +
        '<td>' + esc(r.winner || '—') + '</td>' +
        '<td>' + esc(r.control_ctr != null ? r.control_ctr + '%' : '—') + '</td>' +
        '<td>' + esc(r.test_ctr != null ? r.test_ctr + '%' : '—') + '</td>' +
        '<td>' + esc(r.days_run ?? '—') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    hb.innerHTML = html;
  }
})();
`;

// ─── main / CLI ──────────────────────────────────────────────────────────

export function main(argv = process.argv) {
  const args = parseArgs(argv.slice(2));
  const rootDir = resolve(args.root ?? process.cwd());
  const outPath = resolve(args.out ?? join(rootDir, 'docs/funnel-archive/dashboard.html'));

  const inputs = loadInputs(rootDir);
  const funnel = buildFunnelModel(inputs.config, inputs.snapshot);
  const trend = buildTrendModel(inputs.config, inputs.history);
  const experiment = buildExperimentModel(inputs.config, inputs.snapshot, inputs.evaluation, inputs.plan);

  const html = renderHTML({
    config: inputs.config,
    funnel,
    trend,
    experiment,
    history: inputs.state?.history ?? [],
    meta: inputs.snapshot.meta,
    kpiByName: inputs.snapshot.kpi ?? {},
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  // Console summary (mirrors collect-data.mjs style).
  console.log('=== Funnel Dashboard ===');
  console.log('Output: ' + outPath);
  console.log('Funnel steps: ' + funnel.length);
  console.log('Trend weeks: ' + (trend.available ? trend.weeks.length : 0));
  console.log('Active experiment: ' + (experiment ? experiment.name ?? 'unnamed' : 'none'));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') { out.root = argv[++i]; }
    else if (a === '--out') { out.out = argv[++i]; }
  }
  return out;
}

// Only run main when invoked directly (not when imported by tests).
const __thisFile = fileURLToPath(import.meta.url);
const __invokedDirect = process.argv[1] && resolve(process.argv[1]) === __thisFile;
if (__invokedDirect) {
  try { main(); }
  catch (err) { console.error(err.message); process.exit(1); }
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
