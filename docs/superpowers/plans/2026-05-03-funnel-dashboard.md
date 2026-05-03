# Funnel Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dep static-HTML funnel dashboard that visualizes weekly PostHog snapshots — week-over-week trend, current funnel vs target (including purchase), and active A/B Test vs Control side-by-side — into a single self-contained `dashboard.html` file.

**Architecture:** A new Node script `scripts/render-dashboard.mjs` reads existing `.funnel-state/*.json` snapshots and `funnel-config.json`, runs them through pure-function builders, and emits one self-contained HTML file with inline CSS, inline SVG, and inlined JSON data. The script is wired into `archive.mjs` and exposed as `npm run dashboard`. All builders are unit-tested with `node:test` against animalface-style fixtures.

**Tech Stack:** Node 18+ (native `fetch`, `node:test`, `node:fs`, ESM `.mjs`). No npm dependencies. Browser side: vanilla JS + inline SVG. No frameworks, no CDNs.

**Spec:** `docs/superpowers/specs/2026-05-03-funnel-dashboard-design.md`

---

## File Structure

| Path | Purpose | Status |
|---|---|---|
| `scripts/render-dashboard.mjs` | Main script — exports pure functions + has `main()` CLI entry | Create |
| `scripts/render-dashboard.test.mjs` | All unit tests (uses `node:test`) | Create |
| `tests/fixtures/dashboard/funnel-config.json` | Test config (animalface-derived) | Create |
| `tests/fixtures/dashboard/snapshot-week-7.json` | Week-7 snapshot with active experiment | Create |
| `tests/fixtures/dashboard/snapshot-week-6.json` | Week-6 snapshot, no variants | Create |
| `tests/fixtures/dashboard/snapshot-week-5.json` | Week-5 snapshot, earliest | Create |
| `tests/fixtures/dashboard/state.json` | Active experiment + history | Create |
| `tests/fixtures/dashboard/evaluation-result.json` | p-value + decision | Create |
| `package.json` | Add `dashboard`, `test` scripts | Modify |
| `scripts/archive.mjs` | Add post-archive `render-dashboard` invocation | Modify |
| `examples/animalface/dashboard.html` | Committed demo, generated from fixtures | Create |
| `README.md` | Add "Visual Dashboard" section pointing at demo | Modify |
| `.gitignore` | Ensure `.funnel-state/` stays gitignored (verify) | Verify |

**Module shape inside `render-dashboard.mjs` (single file with named exports for testability):**

```
loadInputs(rootDir)              // returns { config, snapshot, history[], state, evaluation, plan }
detectPurchaseStep(config)       // returns step name or null
buildFunnelModel(config, snap)   // returns FunnelStep[]
buildTrendModel(config, history) // returns { weeks: [{date, steps: FunnelStep[]}], available }
buildExperimentModel(config, snap, evaluation, plan) // returns ExperimentModel | null
pValueTwoProp(c1, n1, c2, n2)    // returns { p, z } | null
formatNumber(n) / formatPct(x) / escapeHtml(s) / statusForKpi(currentPct, targetPct)
renderHTML(models, meta)         // returns full HTML string
main(argv)                       // CLI: orchestrates, writes file, prints path
```

The script ends with a `if (import.meta.url === ...) main(process.argv);` guard so importing it in tests does not execute `main`.

---

## Conventions

- **TDD**: every pure function gets a failing test first, then minimal implementation, then green.
- **Commits**: at the end of each task. Conventional-commit style: `feat:`, `test:`, `chore:`, `docs:`.
- **No npm deps added.** Verify by running `cat package.json | grep -E '"(dependencies|devDependencies)"'` after every task — should remain absent.
- **Test runner**: `node --test scripts/render-dashboard.test.mjs`.
- **All paths in this plan are relative to repo root** `/home/ubuntu/workspace/funnel-optimize/`.

---

## Task 1: Test infrastructure + fixtures

**Files:**
- Create: `tests/fixtures/dashboard/funnel-config.json`
- Create: `tests/fixtures/dashboard/snapshot-week-7.json`
- Create: `tests/fixtures/dashboard/snapshot-week-6.json`
- Create: `tests/fixtures/dashboard/snapshot-week-5.json`
- Create: `tests/fixtures/dashboard/state.json`
- Create: `tests/fixtures/dashboard/evaluation-result.json`
- Create: `scripts/render-dashboard.test.mjs` (skeleton)
- Modify: `package.json` — add `test` script

These fixtures are derived from the animalface case study (`examples/animalface/case-study.md`, `status-snapshot.md`). The shapes match what `scripts/collect-data.mjs` actually emits today.

- [ ] **Step 1: Create the test config fixture**

Create `tests/fixtures/dashboard/funnel-config.json`:

```json
{
  "project": {
    "name": "animalface-test-fixture",
    "framework": "react",
    "north_star": {
      "metric": "weekly_paid_users",
      "target": "growth"
    }
  },
  "automation": {
    "enabled": true,
    "experiment_duration_days": 14
  },
  "optimization_targets": [
    {
      "kpi": "premium_paid_rate",
      "metric_name": "Premium Paid Rate",
      "impression_event": "result_view",
      "click_events": ["premium_paid"],
      "current": 0,
      "target": 1.0,
      "priority": "P0",
      "direction": "higher"
    },
    {
      "kpi": "checkout_paid_rate",
      "metric_name": "Checkout to Paid",
      "impression_event": "premium_checkout",
      "click_events": ["premium_paid"],
      "current": 0,
      "target": 50.0,
      "priority": "P0",
      "direction": "higher"
    },
    {
      "kpi": "premium_cta_ctr",
      "metric_name": "Premium CTA CTR",
      "impression_event": "premium_cta_impression",
      "click_events": ["premium_click"],
      "current": 1.26,
      "target": 4.0,
      "priority": "P2",
      "direction": "higher"
    }
  ],
  "funnel": {
    "steps": ["$pageview", "photo_upload", "result_view", "premium_checkout", "premium_paid"]
  },
  "dashboard": {
    "trend_weeks": 8,
    "default_scale": "auto"
  }
}
```

- [ ] **Step 2: Create week-7 snapshot fixture (with active experiment)**

Create `tests/fixtures/dashboard/snapshot-week-7.json`:

```json
{
  "meta": {
    "generated_at": "2026-05-03T00:00:00.000Z",
    "period_days": 7,
    "period_start": "2026-04-26",
    "period_end": "2026-05-03"
  },
  "kpi": {
    "premium_paid_rate": { "impressions": 9562, "clicks": 2, "ctr": 0.02, "target_ctr": 1.0, "gap": 0.98 },
    "checkout_paid_rate": { "impressions": 60, "clicks": 2, "ctr": 3.33, "target_ctr": 50.0, "gap": 46.67 },
    "premium_cta_ctr": { "impressions": 3739, "clicks": 85, "ctr": 2.27, "target_ctr": 4.0, "gap": 1.73 }
  },
  "checkout_error_rate": 0,
  "funnel": {
    "name": "funnel_steps",
    "results": [
      ["$pageview", 11563],
      ["photo_upload", 9712],
      ["result_view", 9562],
      ["premium_checkout", 60],
      ["premium_paid", 2]
    ]
  },
  "daily_traffic": { "name": "daily_traffic", "results": [
    ["2026-04-26", 1700, 1654],
    ["2026-04-27", 1680, 1641],
    ["2026-04-28", 1620, 1580],
    ["2026-04-29", 1700, 1660],
    ["2026-04-30", 1690, 1647],
    ["2026-05-01", 1640, 1600],
    ["2026-05-02", 1533, 1781]
  ]},
  "event_summary": { "name": "event_summary", "results": [["$pageview", 11563, 11563]] },
  "experiment_variants": {
    "name": "experiment_variants",
    "results": [
      ["control", "result_view", 4631, 4631],
      ["control", "premium_checkout", 8, 8],
      ["control", "premium_paid", 0, 0],
      ["test", "result_view", 4931, 4931],
      ["test", "premium_checkout", 52, 52],
      ["test", "premium_paid", 2, 2]
    ]
  },
  "value_metrics": {},
  "state": { "active_experiment": { "flag_key": "funnel-exp-20260426-premium-first-layout" } }
}
```

- [ ] **Step 3: Create week-6 snapshot fixture (no active experiment)**

Create `tests/fixtures/dashboard/snapshot-week-6.json`:

```json
{
  "meta": {
    "generated_at": "2026-04-26T00:00:00.000Z",
    "period_days": 7,
    "period_start": "2026-04-19",
    "period_end": "2026-04-26"
  },
  "kpi": {
    "premium_paid_rate": { "impressions": 8800, "clicks": 0, "ctr": 0.0, "target_ctr": 1.0, "gap": 1.0 },
    "checkout_paid_rate": { "impressions": 6, "clicks": 0, "ctr": 0.0, "target_ctr": 50.0, "gap": 50.0 },
    "premium_cta_ctr": { "impressions": 3500, "clicks": 7, "ctr": 0.20, "target_ctr": 4.0, "gap": 3.80 }
  },
  "checkout_error_rate": 0,
  "funnel": {
    "name": "funnel_steps",
    "results": [
      ["$pageview", 10800],
      ["photo_upload", 8950],
      ["result_view", 8800],
      ["premium_checkout", 6],
      ["premium_paid", 0]
    ]
  },
  "daily_traffic": { "name": "daily_traffic", "results": [] },
  "event_summary": { "name": "event_summary", "results": [] },
  "experiment_variants": null,
  "value_metrics": {},
  "state": {}
}
```

- [ ] **Step 4: Create week-5 snapshot fixture**

Create `tests/fixtures/dashboard/snapshot-week-5.json`:

```json
{
  "meta": {
    "generated_at": "2026-04-19T00:00:00.000Z",
    "period_days": 7,
    "period_start": "2026-04-12",
    "period_end": "2026-04-19"
  },
  "kpi": {
    "premium_paid_rate": { "impressions": 8400, "clicks": 0, "ctr": 0.0, "target_ctr": 1.0, "gap": 1.0 },
    "checkout_paid_rate": { "impressions": 4, "clicks": 0, "ctr": 0.0, "target_ctr": 50.0, "gap": 50.0 },
    "premium_cta_ctr": { "impressions": 3200, "clicks": 4, "ctr": 0.13, "target_ctr": 4.0, "gap": 3.87 }
  },
  "checkout_error_rate": 0,
  "funnel": {
    "name": "funnel_steps",
    "results": [
      ["$pageview", 10100],
      ["photo_upload", 8500],
      ["result_view", 8400],
      ["premium_checkout", 4],
      ["premium_paid", 0]
    ]
  },
  "daily_traffic": { "name": "daily_traffic", "results": [] },
  "event_summary": { "name": "event_summary", "results": [] },
  "experiment_variants": null,
  "value_metrics": {},
  "state": {}
}
```

- [ ] **Step 5: Create state and evaluation fixtures**

Create `tests/fixtures/dashboard/state.json`:

```json
{
  "active_experiment": {
    "name": "Premium-First Result Layout",
    "flag_key": "funnel-exp-20260426-premium-first-layout",
    "started_at": "2026-04-26",
    "duration_days": 14,
    "target_kpi": "premium_paid_rate"
  },
  "history": [
    { "experiment_name": "Premium CTA reframe", "target_kpi": "premium_cta_ctr", "result": { "winner": "control", "control_ctr": 1.26, "test_ctr": 1.10, "days_run": 7 } },
    { "experiment_name": "Progress CTA (Zeigarnik)", "target_kpi": "premium_cta_ctr", "result": { "winner": "control", "control_ctr": 1.30, "test_ctr": 0.73, "days_run": 7 } },
    { "experiment_name": "Share Compare 3-variant", "target_kpi": "share_total_ctr", "result": { "winner": "control", "control_ctr": 1.34, "test_ctr": 1.10, "days_run": 7 } },
    { "experiment_name": "Offerwall Share Bundle", "target_kpi": "share_total_ctr", "result": { "winner": "kill", "control_ctr": 1.69, "test_ctr": 0.22, "days_run": 7 } },
    { "experiment_name": "Premium Skip-the-Wait", "target_kpi": "premium_cta_ctr", "result": { "winner": "ship_then_revert", "control_ctr": 0.40, "test_ctr": 2.49, "days_run": 7 } },
    { "experiment_name": "Wait Screen Share Revival", "target_kpi": "share_total_ctr", "result": { "winner": "kill", "control_ctr": 1.45, "test_ctr": 0.0, "days_run": 0 } }
  ]
}
```

Create `tests/fixtures/dashboard/evaluation-result.json`:

```json
{
  "experiment": "Premium-First Result Layout",
  "flag_key": "funnel-exp-20260426-premium-first-layout",
  "decision": { "action": "continue", "reason": "p=0.1682 not yet significant; first revenue signal" },
  "p_value": 0.1682,
  "metrics": {
    "control": { "impressions": 4631, "clicks": 0, "ctr": 0.0 },
    "test": { "impressions": 4931, "clicks": 2, "ctr": 0.0406 }
  }
}
```

- [ ] **Step 6: Create the test file skeleton**

Create `scripts/render-dashboard.test.mjs`:

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// All tests will live here. We import from render-dashboard.mjs as it grows.
// This skeleton verifies node:test wiring works before any implementation.

test('node:test runner is wired up', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 7: Add the test script to package.json**

Read `package.json`, then modify the `scripts` block to add a `test` entry. The block should look like:

```json
"scripts": {
  "discover": "node scripts/discover.mjs",
  "collect": "node scripts/collect-data.mjs --days 7",
  "evaluate": "node scripts/evaluate-experiment.mjs",
  "implement": "node scripts/implement-experiment.mjs",
  "archive": "node scripts/archive.mjs",
  "orchestrate": "bash scripts/orchestrate-triple-agent.sh",
  "test": "node --test scripts/render-dashboard.test.mjs"
}
```

- [ ] **Step 8: Run the skeleton test to verify wiring**

Run: `npm test`
Expected: `# tests 1` and `# pass 1`. Exit code 0.

- [ ] **Step 9: Commit**

```bash
git add tests/fixtures/dashboard package.json scripts/render-dashboard.test.mjs
git commit -m "test: scaffold node:test runner + animalface fixtures"
```

---

## Task 2: pValueTwoProp pure function (TDD)

**Files:**
- Create: `scripts/render-dashboard.mjs`
- Modify: `scripts/render-dashboard.test.mjs`

Two-proportion z-test → two-tailed p-value. Pure math, no IO. We start here because it's the easiest to TDD and we'll need it for the experiment model.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `scripts/render-dashboard.test.mjs` with:

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { pValueTwoProp } from './render-dashboard.mjs';

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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: All 4 tests fail with `Cannot find module './render-dashboard.mjs'` or similar.

- [ ] **Step 3: Implement minimal `pValueTwoProp` + module skeleton**

Create `scripts/render-dashboard.mjs`:

```js
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
  if (n1 < 30 || n2 < 30) return null;
  if (n1 <= 0 || n2 <= 0) return null;

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 4 passing tests, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-dashboard.mjs scripts/render-dashboard.test.mjs
git commit -m "feat(dashboard): pValueTwoProp pure function with z-test"
```

---

## Task 3: loadInputs() with graceful fallbacks

**Files:**
- Modify: `scripts/render-dashboard.mjs`
- Modify: `scripts/render-dashboard.test.mjs`

Reads `funnel-config.json`, `latest-snapshot.json` (required), and the optional state files. Globs `weekly-snapshot-*.json` into `history[]` sorted ascending by date. Throws an actionable error when the required snapshot is missing. The function takes a root directory so tests can point it at fixtures.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/render-dashboard.test.mjs`:

```js
import { loadInputs } from './render-dashboard.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function buildFixtureRoot({ withLatest = true, withHistory = true, withState = true, withEval = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fnopt-'));
  const stateDir = join(root, '.funnel-state');
  mkdirSync(stateDir, { recursive: true });

  // Always write config at the project root.
  copyFileSync('tests/fixtures/dashboard/funnel-config.json', join(root, 'funnel-config.json'));

  if (withLatest) {
    copyFileSync('tests/fixtures/dashboard/snapshot-week-7.json', join(stateDir, 'latest-snapshot.json'));
  }
  if (withHistory) {
    copyFileSync('tests/fixtures/dashboard/snapshot-week-5.json', join(stateDir, 'weekly-snapshot-2026-04-19.json'));
    copyFileSync('tests/fixtures/dashboard/snapshot-week-6.json', join(stateDir, 'weekly-snapshot-2026-04-26.json'));
    copyFileSync('tests/fixtures/dashboard/snapshot-week-7.json', join(stateDir, 'weekly-snapshot-2026-05-03.json'));
  }
  if (withState) {
    copyFileSync('tests/fixtures/dashboard/state.json', join(stateDir, 'state.json'));
  }
  if (withEval) {
    copyFileSync('tests/fixtures/dashboard/evaluation-result.json', join(stateDir, 'evaluation-result.json'));
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: 4 new tests fail (`loadInputs is not a function` or import error).

- [ ] **Step 3: Implement `loadInputs`**

Append to `scripts/render-dashboard.mjs`:

```js
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
      `No snapshot found at ${latestPath}.\n` +
      `Run 'npm run collect' first to produce a weekly snapshot, ` +
      `then re-run the dashboard.`,
    );
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const snapshot = JSON.parse(readFileSync(latestPath, 'utf-8'));

  // Globs are simple here; just filter by prefix.
  const history = existsSync(stateDir)
    ? readdirSync(stateDir)
        .filter((f) => /^weekly-snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort() // ISO-date filenames sort lexicographically == chronologically
        .map((f) => JSON.parse(readFileSync(join(stateDir, f), 'utf-8')))
    : [];

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 8 passing tests total (4 from Task 2 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/render-dashboard.mjs scripts/render-dashboard.test.mjs
git commit -m "feat(dashboard): loadInputs reads snapshots + config with fallbacks"
```

---

## Task 4: detectPurchaseStep heuristic

**Files:**
- Modify: `scripts/render-dashboard.mjs`
- Modify: `scripts/render-dashboard.test.mjs`

Heuristic: pick the funnel step that is a `click_event` of the highest-priority `optimization_targets[]` entry with `priority: "P0"` and `direction: "higher"`. Fall back to the last `funnel.steps` entry. If `config.dashboard.purchase_step_override` is set, honor it.

- [ ] **Step 1: Write failing tests**

Append to `scripts/render-dashboard.test.mjs`:

```js
import { detectPurchaseStep } from './render-dashboard.mjs';

test('detectPurchaseStep picks the P0 click event that appears in funnel steps', () => {
  const config = JSON.parse(
    readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'),
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
```

Add `import { readFileSync } from 'node:fs';` near the top of the test file if not already imported.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: 4 new tests fail.

- [ ] **Step 3: Implement `detectPurchaseStep`**

Append to `scripts/render-dashboard.mjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 12 passing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-dashboard.mjs scripts/render-dashboard.test.mjs
git commit -m "feat(dashboard): detectPurchaseStep heuristic with override"
```

---

## Task 5: buildFunnelModel

**Files:**
- Modify: `scripts/render-dashboard.mjs`
- Modify: `scripts/render-dashboard.test.mjs`

Walk `config.funnel.steps`, look up users from `snapshot.funnel.results`, compute cumulative rate from first step and step-to-step drop-off. Attach KPI summary to steps that match an optimization target's click event.

- [ ] **Step 1: Write failing tests**

Append to `scripts/render-dashboard.test.mjs`:

```js
import { buildFunnelModel } from './render-dashboard.mjs';

test('buildFunnelModel produces a step per config.funnel.steps with users + rates', () => {
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const snapshot = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-7.json', 'utf-8'));

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
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const snapshot = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-7.json', 'utf-8'));
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
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const snapshot = {
    meta: {}, funnel: { results: [['$pageview', 1000]] }, kpi: {},
  };
  const model = buildFunnelModel(config, snapshot);
  assert.equal(model[0].users, 1000);
  assert.equal(model[1].users, 0);
  assert.equal(model[1].missing, true);
});

test('buildFunnelModel returns rateFromFirst=null when first step has 0 users', () => {
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const snapshot = { meta: {}, funnel: { results: [['$pageview', 0]] }, kpi: {} };
  const model = buildFunnelModel(config, snapshot);
  assert.equal(model[0].users, 0);
  assert.equal(model[0].rateFromFirst, null);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: 4 new tests fail.

- [ ] **Step 3: Implement `buildFunnelModel` plus `statusForKpi` helper**

Append to `scripts/render-dashboard.mjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 16 passing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-dashboard.mjs scripts/render-dashboard.test.mjs
git commit -m "feat(dashboard): buildFunnelModel with rates, drop-off, KPI attach"
```

---

## Task 6: buildTrendModel

**Files:**
- Modify: `scripts/render-dashboard.mjs`
- Modify: `scripts/render-dashboard.test.mjs`

Walks `history[]` (already sorted ascending by `loadInputs`), runs `buildFunnelModel` per snapshot, returns `{ available, weeks: [{ periodEnd, steps }], purchaseStep }`. Caps to `config.dashboard.trend_weeks` (default 8) by keeping the most recent N. Sets `available=false` when fewer than 2 weeks exist.

- [ ] **Step 1: Write failing tests**

Append to `scripts/render-dashboard.test.mjs`:

```js
import { buildTrendModel } from './render-dashboard.mjs';

test('buildTrendModel returns weeks built from history with available=true when N>=2', () => {
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const w5 = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-5.json', 'utf-8'));
  const w6 = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-6.json', 'utf-8'));
  const w7 = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-7.json', 'utf-8'));

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
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const w7 = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-7.json', 'utf-8'));
  assert.equal(buildTrendModel(config, []).available, false);
  assert.equal(buildTrendModel(config, [w7]).available, false);
});

test('buildTrendModel respects dashboard.trend_weeks cap', () => {
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const w5 = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-5.json', 'utf-8'));
  const w6 = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-6.json', 'utf-8'));
  const w7 = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-7.json', 'utf-8'));
  const capped = { ...config, dashboard: { ...(config.dashboard || {}), trend_weeks: 2 } };
  const trend = buildTrendModel(capped, [w5, w6, w7]);
  assert.equal(trend.weeks.length, 2);
  // Should keep the most recent 2 weeks
  assert.equal(trend.weeks[0].periodEnd, '2026-04-26');
  assert.equal(trend.weeks[1].periodEnd, '2026-05-03');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: 3 new tests fail.

- [ ] **Step 3: Implement `buildTrendModel`**

Append to `scripts/render-dashboard.mjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 19 passing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-dashboard.mjs scripts/render-dashboard.test.mjs
git commit -m "feat(dashboard): buildTrendModel with trend_weeks cap"
```

---

## Task 7: buildExperimentModel

**Files:**
- Modify: `scripts/render-dashboard.mjs`
- Modify: `scripts/render-dashboard.test.mjs`

Groups `snapshot.experiment_variants.results` by variant, builds a per-variant funnel (rate-from-first), and produces a per-step lift comparison. Pulls `p_value` and `decision` from the evaluation file when present, otherwise computes p-value at the purchase step using `pValueTwoProp`. Returns `null` when `experiment_variants` is null/empty.

The variant rows have shape `[variant, event, count, users]`. We use `users` as the per-step user count.

- [ ] **Step 1: Write failing tests**

Append to `scripts/render-dashboard.test.mjs`:

```js
import { buildExperimentModel } from './render-dashboard.mjs';

test('buildExperimentModel returns null when experiment_variants is missing', () => {
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const snap = { funnel: { results: [] }, experiment_variants: null };
  assert.equal(buildExperimentModel(config, snap, null, null), null);
});

test('buildExperimentModel groups variants and computes per-step rate + lift', () => {
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const snap = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-7.json', 'utf-8'));
  const evalRes = JSON.parse(readFileSync('tests/fixtures/dashboard/evaluation-result.json', 'utf-8'));
  const state = JSON.parse(readFileSync('tests/fixtures/dashboard/state.json', 'utf-8'));

  const m = buildExperimentModel(config, snap, evalRes, null);
  assert.ok(m, 'expected an experiment model');
  assert.equal(m.flagKey ?? null, null); // not pulled here yet
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
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const snap = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-7.json', 'utf-8'));
  const m = buildExperimentModel(config, snap, null, null);
  assert.ok(m);
  // Inline p-value: control 0/4631, test 2/4931 → ~0.17
  assert.ok(m.pValue !== null && m.pValue > 0.10 && m.pValue < 0.30);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: 3 new tests fail.

- [ ] **Step 3: Implement `buildExperimentModel`**

Append to `scripts/render-dashboard.mjs`:

```js
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
    const firstUsers = m.get(steps[0]) ?? 0;
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
    let lift = null;
    if (controlRate === 0 && testRate === 0) lift = 0;
    else if (controlRate === 0) lift = Infinity;
    else lift = (testRate - controlRate) / controlRate;
    return { name: s, controlRate, testRate, lift };
  });

  // p-value at the purchase step.
  let pValue = evaluation?.p_value ?? null;
  if (pValue === null && purchaseStep) {
    const cUsers = byVariant.get(controlKey)?.get(steps[0]) ?? 0;
    const tUsers = byVariant.get(testKey)?.get(steps[0]) ?? 0;
    const cPaid = byVariant.get(controlKey)?.get(purchaseStep) ?? 0;
    const tPaid = byVariant.get(testKey)?.get(purchaseStep) ?? 0;
    const r = pValueTwoProp(cPaid, cUsers, tPaid, tUsers);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 22 passing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-dashboard.mjs scripts/render-dashboard.test.mjs
git commit -m "feat(dashboard): buildExperimentModel with lift + p-value fallback"
```

---

## Task 8: Format helpers

**Files:**
- Modify: `scripts/render-dashboard.mjs`
- Modify: `scripts/render-dashboard.test.mjs`

Tiny pure helpers used by `renderHTML`. Tested separately so the renderer itself can stay simple.

- [ ] **Step 1: Write failing tests**

Append to `scripts/render-dashboard.test.mjs`:

```js
import { formatNumber, formatPct, formatRate, escapeHtml, formatLift, formatPValue } from './render-dashboard.mjs';

test('formatNumber adds thousands separators and handles small/large values', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(2), '2');
  assert.equal(formatNumber(1234), '1,234');
  assert.equal(formatNumber(11563), '11,563');
});

test('formatPct converts a 0..1 fraction to a "%.X%" string', () => {
  assert.equal(formatPct(0.5), '50.0%');
  assert.equal(formatPct(0.0337 / 100), '0.03%'); // 0.0337% rounds to 0.03 at 2dp
  assert.equal(formatPct(null), '—');
});

test('formatRate formats a percentage value already in percent units', () => {
  assert.equal(formatRate(0.02), '0.02%');
  assert.equal(formatRate(50), '50.0%');
  assert.equal(formatRate(null), '—');
});

test('escapeHtml escapes the dangerous characters', () => {
  assert.equal(escapeHtml('<script>"a&b"</script>'), '&lt;script&gt;&quot;a&amp;b&quot;&lt;/script&gt;');
});

test('formatLift renders dashes for non-finite values', () => {
  assert.equal(formatLift(Infinity), '—');
  assert.equal(formatLift(null), '—');
  assert.equal(formatLift(0), '+0.0%');
  assert.equal(formatLift(0.521), '+52.1%');
  assert.equal(formatLift(-0.337), '-33.7%');
});

test('formatPValue annotates significance at 0.05', () => {
  assert.equal(formatPValue(0.04), 'p=0.040 — significant');
  assert.equal(formatPValue(0.17), 'p=0.170 — not significant');
  assert.equal(formatPValue(null), 'sample too small for inference');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: 6 new tests fail.

- [ ] **Step 3: Implement helpers**

Append to `scripts/render-dashboard.mjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 28 passing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-dashboard.mjs scripts/render-dashboard.test.mjs
git commit -m "feat(dashboard): formatting helpers for numbers, rates, lift, p-values"
```

---

## Task 9: renderHTML

**Files:**
- Modify: `scripts/render-dashboard.mjs`
- Modify: `scripts/render-dashboard.test.mjs`

Assembles the full HTML string. Embeds the model as `<script type="application/json" id="data">…</script>`, then a small inline `<script>` that reads it and renders the SVGs and toggle. The HTML structure is fixed; the data drives values, widths, labels.

We keep `renderHTML` itself pure (no FS), but the script it emits runs in the browser. The test asserts that key sections exist or are absent based on the model.

- [ ] **Step 1: Write failing tests**

Append to `scripts/render-dashboard.test.mjs`:

```js
import { renderHTML } from './render-dashboard.mjs';

test('renderHTML produces a complete HTML document with inlined data block', () => {
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const snap = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-7.json', 'utf-8'));
  const w5 = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-5.json', 'utf-8'));
  const w6 = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-6.json', 'utf-8'));
  const evalRes = JSON.parse(readFileSync('tests/fixtures/dashboard/evaluation-result.json', 'utf-8'));
  const state = JSON.parse(readFileSync('tests/fixtures/dashboard/state.json', 'utf-8'));

  const html = renderHTML({
    config,
    funnel: buildFunnelModel(config, snap),
    trend: buildTrendModel(config, [w5, w6, snap]),
    experiment: buildExperimentModel(config, snap, evalRes, null),
    history: state.history,
    meta: snap.meta,
    kpiByName: snap.kpi,
  });

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<script type="application\/json" id="data">/);
  assert.match(html, /id="funnel-current"/);
  assert.match(html, /id="funnel-trend"/);
  assert.match(html, /id="funnel-experiment"/);
  // No external assets
  assert.equal(/https?:\/\//.test(html.match(/<link[^>]+>/g)?.join('') ?? ''), false);
});

test('renderHTML hides the trend section when trend.available is false', () => {
  const config = JSON.parse(readFileSync('tests/fixtures/dashboard/funnel-config.json', 'utf-8'));
  const snap = JSON.parse(readFileSync('tests/fixtures/dashboard/snapshot-week-7.json', 'utf-8'));
  const html = renderHTML({
    config,
    funnel: buildFunnelModel(config, snap),
    trend: { available: false, weeks: [] },
    experiment: null,
    history: [],
    meta: snap.meta,
    kpiByName: snap.kpi,
  });
  // Trend container is hidden
  assert.match(html, /id="funnel-trend"[^>]*data-empty="true"/);
  assert.match(html, /Run for 2\+ weeks/i);
  // A/B section also hidden
  assert.match(html, /id="funnel-experiment"[^>]*data-empty="true"/);
});

test('renderHTML escapes config-driven strings', () => {
  const config = {
    project: { name: '<x>"&y' },
    funnel: { steps: ['$pageview'] },
    optimization_targets: [],
  };
  const snap = { meta: { period_end: '2026-05-03', period_days: 7 }, funnel: { results: [['$pageview', 1]] }, kpi: {} };
  const html = renderHTML({
    config,
    funnel: buildFunnelModel(config, snap),
    trend: { available: false, weeks: [] },
    experiment: null,
    history: [],
    meta: snap.meta,
    kpiByName: snap.kpi,
  });
  assert.ok(html.includes('&lt;x&gt;'));
  assert.ok(!html.includes('<x>'));
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: 3 new tests fail.

- [ ] **Step 3: Implement `renderHTML`**

This is the longest single addition. Append to `scripts/render-dashboard.mjs`:

```js
// ─── renderHTML ──────────────────────────────────────────────────────────
//
// Pure: takes models in, returns a full HTML document string.
// All CSS / JS / SVG / data is inlined. No external requests.

export function renderHTML({ config, funnel, trend, experiment, history, meta, kpiByName }) {
  const projectName = escapeHtml(config?.project?.name ?? 'Funnel Optimize');
  const periodEnd = escapeHtml(meta?.period_end ?? '');
  const periodDays = meta?.period_days ?? 7;
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
      <h2>Trend — last ${trend?.weeks?.length ?? 0} weeks</h2>
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 31 passing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-dashboard.mjs scripts/render-dashboard.test.mjs
git commit -m "feat(dashboard): renderHTML assembles full self-contained document"
```

---

## Task 10: CLI main() entrypoint

**Files:**
- Modify: `scripts/render-dashboard.mjs`

Wire `loadInputs → models → renderHTML → write file`. Accept `--root` and `--out` flags. Default output: `<root>/docs/funnel-archive/dashboard.html`. Ensure import-not-execute behavior so tests don't accidentally run `main`.

- [ ] **Step 1: Append `main` to `scripts/render-dashboard.mjs`**

```js
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
```

- [ ] **Step 2: Smoke-test against fixtures**

Build a temporary fixture root and run the CLI against it:

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/.funnel-state"
cp tests/fixtures/dashboard/funnel-config.json "$TMP/funnel-config.json"
cp tests/fixtures/dashboard/snapshot-week-7.json "$TMP/.funnel-state/latest-snapshot.json"
cp tests/fixtures/dashboard/snapshot-week-5.json "$TMP/.funnel-state/weekly-snapshot-2026-04-19.json"
cp tests/fixtures/dashboard/snapshot-week-6.json "$TMP/.funnel-state/weekly-snapshot-2026-04-26.json"
cp tests/fixtures/dashboard/snapshot-week-7.json "$TMP/.funnel-state/weekly-snapshot-2026-05-03.json"
cp tests/fixtures/dashboard/state.json "$TMP/.funnel-state/state.json"
cp tests/fixtures/dashboard/evaluation-result.json "$TMP/.funnel-state/evaluation-result.json"
node scripts/render-dashboard.mjs --root "$TMP"
ls -la "$TMP/docs/funnel-archive/dashboard.html"
```

Expected: a file is written at `$TMP/docs/funnel-archive/dashboard.html` and the console prints `Funnel steps: 5`, `Trend weeks: 3`, `Active experiment: Premium-First Result Layout`.

- [ ] **Step 3: Verify "no snapshot" produces an actionable error**

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/.funnel-state"
cp tests/fixtures/dashboard/funnel-config.json "$TMP/funnel-config.json"
node scripts/render-dashboard.mjs --root "$TMP" || echo "exited non-zero (good)"
```

Expected: stderr contains `No snapshot found`, exit code is non-zero.

- [ ] **Step 4: Run unit tests once more to confirm import-not-execute works**

Run: `npm test`
Expected: 31 passing tests, no spurious "no snapshot" output (because tests import the module without invoking `main`).

- [ ] **Step 5: Commit**

```bash
git add scripts/render-dashboard.mjs
git commit -m "feat(dashboard): main() CLI entrypoint with --root/--out flags"
```

---

## Task 11: npm run dashboard

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the `dashboard` script**

Modify the `scripts` block of `package.json` to:

```json
"scripts": {
  "discover": "node scripts/discover.mjs",
  "collect": "node scripts/collect-data.mjs --days 7",
  "evaluate": "node scripts/evaluate-experiment.mjs",
  "implement": "node scripts/implement-experiment.mjs",
  "archive": "node scripts/archive.mjs",
  "dashboard": "node scripts/render-dashboard.mjs",
  "orchestrate": "bash scripts/orchestrate-triple-agent.sh",
  "test": "node --test scripts/render-dashboard.test.mjs"
}
```

- [ ] **Step 2: Verify**

Run: `npm run dashboard --help 2>&1 || true`
Expected: the CLI runs (it will likely error with "No snapshot found" because the user's repo has no `.funnel-state/`, which is correct — that's the actionable message).

- [ ] **Step 3: Confirm no new dependencies were added**

Run: `cat package.json | grep -E '"(dependencies|devDependencies)"' || echo "no dep blocks (good)"`
Expected: `no dep blocks (good)`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(dashboard): expose 'npm run dashboard' script"
```

---

## Task 12: Wire dashboard render into archive.mjs

**Files:**
- Modify: `scripts/archive.mjs`

Add a call to `render-dashboard` at the end of the archive run. Failures are caught and logged but do not break archiving.

- [ ] **Step 1: Read the current archive.mjs main**

Confirm that `main()` ends just after `console.log('\nDone.')` at archive.mjs:71 (this is where we'll append).

- [ ] **Step 2: Add the import**

At the top of `scripts/archive.mjs` (near the existing imports), the file already imports things from `./lib.mjs`. We do not want to import `render-dashboard.mjs` directly (because importing would attempt to run `main` only when invoked via CLI, but it's still cleaner to spawn it). Use a child process. Add this near the existing imports:

```js
import { spawnSync } from 'node:child_process';
```

- [ ] **Step 3: Append the render call to `main()`**

Inside `main()`, immediately before `console.log('\nDone.');` (currently at archive.mjs:71), insert:

```js
  // Refresh the visual dashboard (best-effort; archive shouldn't fail because of it).
  console.log('Rendering dashboard...');
  const r = spawnSync(process.execPath, ['scripts/render-dashboard.mjs'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.log('  (dashboard render failed; continuing — see error above)');
  }
```

- [ ] **Step 4: Run archive.mjs against a fixture root**

Build a fake root with a snapshot and run archive end-to-end:

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/.funnel-state" "$TMP/scripts"
cp tests/fixtures/dashboard/funnel-config.json "$TMP/funnel-config.json"
cp tests/fixtures/dashboard/snapshot-week-7.json "$TMP/.funnel-state/latest-snapshot.json"
cp tests/fixtures/dashboard/state.json "$TMP/.funnel-state/state.json"
cp scripts/lib.mjs scripts/archive.mjs scripts/render-dashboard.mjs "$TMP/scripts/"
(cd "$TMP" && node scripts/archive.mjs)
ls -la "$TMP/docs/funnel-archive/"
```

Expected: both the markdown report (`<date>.md`) and `dashboard.html` exist.

- [ ] **Step 5: Commit**

```bash
git add scripts/archive.mjs
git commit -m "feat(dashboard): archive.mjs renders dashboard.html as final step"
```

---

## Task 13: Generate the animalface demo dashboard

**Files:**
- Create: `examples/animalface/.funnel-state/latest-snapshot.json` (temp, NOT committed)
- Create: `examples/animalface/dashboard.html` (committed)

Build the public demo from fixtures so the README can link to a live HTML file.

- [ ] **Step 1: Stage example state**

```bash
mkdir -p examples/animalface/.funnel-state
cp tests/fixtures/dashboard/snapshot-week-7.json examples/animalface/.funnel-state/latest-snapshot.json
cp tests/fixtures/dashboard/snapshot-week-5.json examples/animalface/.funnel-state/weekly-snapshot-2026-04-19.json
cp tests/fixtures/dashboard/snapshot-week-6.json examples/animalface/.funnel-state/weekly-snapshot-2026-04-26.json
cp tests/fixtures/dashboard/snapshot-week-7.json examples/animalface/.funnel-state/weekly-snapshot-2026-05-03.json
cp tests/fixtures/dashboard/state.json examples/animalface/.funnel-state/state.json
cp tests/fixtures/dashboard/evaluation-result.json examples/animalface/.funnel-state/evaluation-result.json
```

The `examples/animalface/funnel-config.json` already exists in the repo, but its `optimization_targets[]` references events not in our test snapshot (e.g., `share_button_impression`). Use the test funnel-config for rendering the demo so the page is consistent:

```bash
cp examples/animalface/funnel-config.json examples/animalface/funnel-config.original.json
cp tests/fixtures/dashboard/funnel-config.json examples/animalface/funnel-config.json
```

- [ ] **Step 2: Render**

```bash
node scripts/render-dashboard.mjs --root examples/animalface --out examples/animalface/dashboard.html
```

Expected: prints `Funnel steps: 5`, `Trend weeks: 3`, `Active experiment: Premium-First Result Layout`. File exists at `examples/animalface/dashboard.html`.

- [ ] **Step 3: Restore the original animalface config and clean state dir**

```bash
mv examples/animalface/funnel-config.original.json examples/animalface/funnel-config.json
rm -rf examples/animalface/.funnel-state
```

- [ ] **Step 4: Smoke-test the HTML**

Open `examples/animalface/dashboard.html` and confirm visually (or via grep):

```bash
grep -c 'id="funnel-current"' examples/animalface/dashboard.html      # → 1
grep -c 'id="funnel-trend"' examples/animalface/dashboard.html        # → 1
grep -c 'id="funnel-experiment"' examples/animalface/dashboard.html   # → 1
grep -c 'PURCHASE' examples/animalface/dashboard.html                  # → 0 (PURCHASE label is rendered client-side only)
grep -c 'premium_paid' examples/animalface/dashboard.html              # → at least 1
```

- [ ] **Step 5: Commit**

```bash
git add examples/animalface/dashboard.html
git commit -m "docs(dashboard): committed animalface demo dashboard.html"
```

---

## Task 14: README + docs pointer

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add a "Visual Dashboard" subsection to README**

Add a new H2 section between "What it does" and "Requirements" (around README.md line 57). Insert:

```markdown
## Visual Dashboard

After any weekly run, `dashboard.html` is regenerated with a single command:

```bash
npm run dashboard
```

It produces a self-contained, zero-dep HTML file at `docs/funnel-archive/dashboard.html` with:

- Week-over-week funnel-rate trend (last 8 weeks by default)
- Current funnel — every step's users, cumulative rate, drop-off, and KPI gap
- Active experiment — Test vs Control side-by-side with lift and p-value at every step (including purchase)
- Compact experiment history table

`archive.mjs` calls it automatically as its final step. Open the file directly in any browser — no server, no CDN, no build.

A live demo from the animalface case study is committed at [`examples/animalface/dashboard.html`](examples/animalface/dashboard.html).
```

- [ ] **Step 2: Add a row to architecture.md's "Code Modules" table**

In `docs/architecture.md`, locate the `## Code Modules` table (around line 113). Add a row before the closing of the table:

```markdown
| `render-dashboard.mjs` | Visual funnel dashboard (HTML output) |
```

- [ ] **Step 3: Verify links resolve**

```bash
grep -c 'examples/animalface/dashboard.html' README.md     # → 1
test -f examples/animalface/dashboard.html && echo OK      # → OK
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/architecture.md
git commit -m "docs(dashboard): README + architecture pointer to dashboard"
```

---

## Final verification

- [ ] **Run the full test suite one more time**

```bash
npm test
```

Expected: 31 tests passing, 0 failing, exit 0.

- [ ] **Confirm zero deps were added**

```bash
cat package.json | grep -E '"(dependencies|devDependencies)"' || echo "no dep blocks (good)"
```

- [ ] **Confirm the demo dashboard opens cleanly**

```bash
file examples/animalface/dashboard.html
wc -l examples/animalface/dashboard.html
```

Expected: HTML document, more than 100 lines.

- [ ] **Browser smoke (manual)**

Open `file://$(pwd)/examples/animalface/dashboard.html` in a browser. Confirm:
- Header reads "animalface-test-fixture — Funnel Dashboard (2026-05-03)"
- Trend section shows three connected line points per series
- Funnel section shows 5 rows; the `premium_paid` row is highlighted (purchase)
- Active experiment section shows Control 0 / Test 2 paid users, with lift "—" (Infinity guarded), p=0.168 — not significant
- Linear ↔ Log toggle visibly changes bar widths
- No external network requests (Network tab in DevTools)

---

## Notes for the implementer

- The CSS uses CSS custom properties so a future dark-mode variant is a 1-line change. Don't pre-build dark mode in v1.
- `pValueTwoProp` and `normalCdf` are standard math; do not optimize prematurely.
- The browser-side JS is intentionally vanilla and ~250 lines. If you reach for a framework, stop — single self-contained HTML is a hard requirement.
- The animalface fixtures use rounded numbers consistent with the published case study but are not byte-for-byte real PostHog output. They exist to test our renderer, not to make claims about animalface's actual revenue.
