import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pValueTwoProp, loadInputs, detectPurchaseStep } from './render-dashboard.mjs';

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
