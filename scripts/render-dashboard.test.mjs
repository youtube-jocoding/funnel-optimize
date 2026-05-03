import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pValueTwoProp, loadInputs, detectPurchaseStep, buildFunnelModel, buildTrendModel, buildExperimentModel } from './render-dashboard.mjs';

const FIXTURES = fileURLToPath(new URL('../tests/fixtures/dashboard/', import.meta.url));

function buildFixtureRoot({ withLatest = true, withHistory = true, withState = true, withEval = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fnopt-'));
  const stateDir = join(root, '.funnel-state');
  mkdirSync(stateDir, { recursive: true });

  // Always write config at the project root.
  copyFileSync(join(FIXTURES, 'funnel-config.json'), join(root, 'funnel-config.json'));

  if (withLatest) {
    copyFileSync(join(FIXTURES, 'snapshot-week-7.json'), join(stateDir, 'latest-snapshot.json'));
  }
  if (withHistory) {
    copyFileSync(join(FIXTURES, 'snapshot-week-5.json'), join(stateDir, 'weekly-snapshot-2026-04-19.json'));
    copyFileSync(join(FIXTURES, 'snapshot-week-6.json'), join(stateDir, 'weekly-snapshot-2026-04-26.json'));
    copyFileSync(join(FIXTURES, 'snapshot-week-7.json'), join(stateDir, 'weekly-snapshot-2026-05-03.json'));
  }
  if (withState) {
    copyFileSync(join(FIXTURES, 'state.json'), join(stateDir, 'state.json'));
  }
  if (withEval) {
    copyFileSync(join(FIXTURES, 'evaluation-result.json'), join(stateDir, 'evaluation-result.json'));
  }
  return root;
}

test('loadInputs reads config + latest snapshot from a fixture root', () => {
  const root = buildFixtureRoot();
  const inputs = loadInputs(root);
  assert.equal(inputs.config.project.name, 'animalface-test-fixture');
  assert.equal(inputs.snapshot.funnel.results[0][0], '$pageview');
  assert.equal(inputs.history.length, 3);
  // History sorted ascending by date in filename
  assert.equal(inputs.history[0].meta.period_end, '2026-04-19');
  assert.equal(inputs.history[2].meta.period_end, '2026-05-03');
  assert.ok(inputs.state.active_experiment);
  assert.equal(inputs.evaluation.p_value, 0.1682);
});

test('loadInputs throws an actionable error when latest-snapshot.json is missing', () => {
  const root = buildFixtureRoot({ withLatest: false });
  assert.throws(
    () => loadInputs(root),
    /no snapshot found.*npm run collect/i,
  );
});

test('loadInputs returns empty history when no weekly snapshots exist', () => {
  const root = buildFixtureRoot({ withHistory: false });
  const inputs = loadInputs(root);
  assert.equal(inputs.history.length, 0);
});

test('loadInputs returns null state/evaluation when those files are missing', () => {
  const root = buildFixtureRoot({ withState: false, withEval: false });
  const inputs = loadInputs(root);
  assert.equal(inputs.state, null);
  assert.equal(inputs.evaluation, null);
});

test('pValueTwoProp returns null when sample is too small', () => {
  // n < 30 per side → undersized
  assert.equal(pValueTwoProp(0, 10, 2, 10), null);
});

test('pValueTwoProp returns p ≈ 1 when proportions are identical', () => {
  const result = pValueTwoProp(50, 1000, 50, 1000);
  assert.ok(result !== null);
  assert.ok(result.p > 0.99, `p should be ≈ 1, got ${result.p}`);
  assert.ok(Math.abs(result.z) < 0.01, `z should be ≈ 0, got ${result.z}`);
});

test('pValueTwoProp matches the animalface week-7 reported p ≈ 0.17', () => {
  // control 0/4631, test 2/4931 — case-study reports p=0.1682
  const result = pValueTwoProp(0, 4631, 2, 4931);
  assert.ok(result !== null);
  // Allow generous tolerance — different test variants give slightly different numbers.
  assert.ok(result.p > 0.10 && result.p < 0.30, `expected p≈0.17, got ${result.p}`);
});

test('pValueTwoProp returns null on zero totals', () => {
  assert.equal(pValueTwoProp(0, 0, 0, 0), null);
});

test('detectPurchaseStep picks the P0 click event that appears in funnel steps', () => {
  const config = JSON.parse(
    readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'),
  );
  // P0 + direction higher → premium_paid_rate, click_events ['premium_paid'].
  // 'premium_paid' is in funnel.steps → that's the purchase step.
  assert.equal(detectPurchaseStep(config), 'premium_paid');
});

test('detectPurchaseStep falls back to the last funnel step when no P0 match', () => {
  const config = {
    funnel: { steps: ['$pageview', 'foo', 'bar'] },
    optimization_targets: [
      { kpi: 'x', click_events: ['nope'], priority: 'P0', direction: 'higher' },
    ],
  };
  assert.equal(detectPurchaseStep(config), 'bar');
});

test('detectPurchaseStep honors config.dashboard.purchase_step_override', () => {
  const config = {
    funnel: { steps: ['$pageview', 'a', 'b', 'c'] },
    dashboard: { purchase_step_override: 'a' },
    optimization_targets: [
      { kpi: 'x', click_events: ['c'], priority: 'P0', direction: 'higher' },
    ],
  };
  assert.equal(detectPurchaseStep(config), 'a');
});

test('detectPurchaseStep returns null when funnel.steps is missing', () => {
  assert.equal(detectPurchaseStep({}), null);
});

test('buildFunnelModel produces a step per config.funnel.steps with users + rates', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const snapshot = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-7.json'), 'utf-8'));

  const model = buildFunnelModel(config, snapshot);
  assert.equal(model.length, 5);
  assert.equal(model[0].name, '$pageview');
  assert.equal(model[0].users, 11563);
  assert.equal(model[0].rateFromFirst, 1);
  assert.equal(model[0].dropFromPrev, null);

  assert.equal(model[1].name, 'photo_upload');
  assert.equal(model[1].users, 9712);
  assert.ok(Math.abs(model[1].rateFromFirst - 9712 / 11563) < 1e-9);
  assert.equal(model[1].dropFromPrev, 9712 - 11563);

  // premium_paid is the purchase step
  assert.equal(model[4].name, 'premium_paid');
  assert.equal(model[4].isPurchase, true);
  assert.equal(model[4].users, 2);

  // Earlier steps are not the purchase step
  assert.equal(model[0].isPurchase, false);
});

test('buildFunnelModel attaches KPI data to steps whose name matches a target click event', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const snapshot = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-7.json'), 'utf-8'));
  const model = buildFunnelModel(config, snapshot);

  // premium_paid is a click_event for premium_paid_rate (P0) — KPI attached
  const paid = model.find((s) => s.name === 'premium_paid');
  assert.ok(paid.kpi, 'premium_paid should have a KPI summary');
  assert.equal(paid.kpi.target_ctr, 1.0);
  assert.equal(paid.kpi.ctr, 0.02);
  assert.equal(paid.kpi.status, 'miss');

  // $pageview is not a click_event for any target — no KPI
  const pv = model.find((s) => s.name === '$pageview');
  assert.equal(pv.kpi, null);
});

test('buildFunnelModel handles missing funnel rows as 0 users with a missing flag', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const snapshot = {
    meta: {}, funnel: { results: [['$pageview', 1000]] }, kpi: {},
  };
  const model = buildFunnelModel(config, snapshot);
  assert.equal(model[0].users, 1000);
  assert.equal(model[1].users, 0);
  assert.equal(model[1].missing, true);
});

test('buildFunnelModel returns rateFromFirst=null when first step has 0 users', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const snapshot = { meta: {}, funnel: { results: [['$pageview', 0]] }, kpi: {} };
  const model = buildFunnelModel(config, snapshot);
  assert.equal(model[0].users, 0);
  assert.equal(model[0].rateFromFirst, null);
});

test('buildTrendModel returns weeks built from history with available=true when N>=2', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const w5 = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-5.json'), 'utf-8'));
  const w6 = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-6.json'), 'utf-8'));
  const w7 = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-7.json'), 'utf-8'));

  const trend = buildTrendModel(config, [w5, w6, w7]);
  assert.equal(trend.available, true);
  assert.equal(trend.weeks.length, 3);
  assert.equal(trend.weeks[0].periodEnd, '2026-04-19');
  assert.equal(trend.weeks[2].periodEnd, '2026-05-03');

  // Each week's steps should be a FunnelStep[] of the same shape buildFunnelModel returns.
  assert.equal(trend.weeks[2].steps[0].name, '$pageview');
  // Cumulative rate to result_view should be ~ 9562 / 11563
  const resultStep = trend.weeks[2].steps.find((s) => s.name === 'result_view');
  assert.ok(Math.abs(resultStep.rateFromFirst - 9562 / 11563) < 1e-9);
});

test('buildTrendModel returns available=false when history has fewer than 2 weeks', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const w7 = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-7.json'), 'utf-8'));
  assert.equal(buildTrendModel(config, []).available, false);
  assert.equal(buildTrendModel(config, [w7]).available, false);
});

test('buildTrendModel respects dashboard.trend_weeks cap', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const w5 = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-5.json'), 'utf-8'));
  const w6 = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-6.json'), 'utf-8'));
  const w7 = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-7.json'), 'utf-8'));
  const capped = { ...config, dashboard: { ...(config.dashboard || {}), trend_weeks: 2 } };
  const trend = buildTrendModel(capped, [w5, w6, w7]);
  assert.equal(trend.weeks.length, 2);
  // Should keep the most recent 2 weeks
  assert.equal(trend.weeks[0].periodEnd, '2026-04-26');
  assert.equal(trend.weeks[1].periodEnd, '2026-05-03');
});

test('buildExperimentModel returns null when experiment_variants is missing', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const snap = { funnel: { results: [] }, experiment_variants: null };
  assert.equal(buildExperimentModel(config, snap, null, null), null);
});

test('buildExperimentModel groups variants and computes per-step rate + lift', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const snap = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-7.json'), 'utf-8'));
  const evalRes = JSON.parse(readFileSync(join(FIXTURES, 'evaluation-result.json'), 'utf-8'));

  const m = buildExperimentModel(config, snap, evalRes, null);
  assert.ok(m, 'expected an experiment model');
  assert.equal(m.pValue, 0.1682);
  assert.equal(m.decision, 'continue');

  // Control & test funnels each have a row per step
  const controlPaid = m.control.find((s) => s.name === 'premium_paid');
  const testPaid = m.test.find((s) => s.name === 'premium_paid');
  assert.equal(controlPaid.users, 0);
  assert.equal(testPaid.users, 2);

  // Lift: test - control over control's rate. control rate = 0, so lift is "infinite"
  // Encode as Infinity, render layer turns it into "—".
  const liftPaid = m.lift.find((l) => l.name === 'premium_paid');
  assert.equal(liftPaid.controlRate, 0);
  assert.ok(testPaid.rateFromFirst > 0);
  assert.equal(liftPaid.lift, Infinity);
});

test('buildExperimentModel falls back to inline p-value when evaluation is null', () => {
  const config = JSON.parse(readFileSync(join(FIXTURES, 'funnel-config.json'), 'utf-8'));
  const snap = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-week-7.json'), 'utf-8'));
  const m = buildExperimentModel(config, snap, null, null);
  assert.ok(m);
  // Inline p-value: control 0/4631, test 2/4931 → ~0.17
  assert.ok(m.pValue !== null && m.pValue > 0.10 && m.pValue < 0.30);
});
