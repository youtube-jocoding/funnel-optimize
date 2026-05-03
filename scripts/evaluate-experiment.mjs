#!/usr/bin/env node

/**
 * Step 4: Evaluate running experiment and decide winner.
 *
 * Usage:
 *   node scripts/funnel-automation/evaluate-experiment.mjs
 *
 * Reads: .funnel-state/state.json, .funnel-state/latest-snapshot.json
 * Decides: keep control, keep test, or continue running
 */

import fs from 'fs';
import path from 'path';
import {
  loadEnv, createPostHogClient, loadConfig, loadState, saveState, ROOT_DIR, formatDate,
} from './lib.mjs';

loadEnv();

async function main() {
  console.log('\n=== Funnel Automation: Evaluate Experiment ===\n');

  const config = loadConfig();
  const state = loadState();
  const posthog = createPostHogClient();
  const forceKill = process.argv.includes('--kill');

  if (!state.active_experiment) {
    console.log('No active experiment. Skipping evaluation.');
    const resultPath = path.resolve(ROOT_DIR, '.funnel-state/evaluation-result.json');
    fs.writeFileSync(resultPath, JSON.stringify({ action: 'none', reason: 'No active experiment' }, null, 2));
    return;
  }

  // Manual kill: immediately disable flag and move to history
  if (forceKill) {
    const exp = state.active_experiment;
    console.log(`Force killing experiment: ${exp.experiment_name}`);
    if (exp.flag_id) {
      try {
        await posthog.updateFeatureFlag(exp.flag_id, { active: false });
        console.log(`  Feature flag ${exp.flag_key} disabled.`);
      } catch (err) {
        console.warn(`  Warning: Could not disable flag: ${err.message}`);
      }
    }
    state.history = state.history || [];
    state.history.push({
      ...exp,
      ended_at: new Date().toISOString(),
      ended_reason: 'killed',
      flag_disabled_at: formatDate(),
    });
    state.active_experiment = null;
    saveState(state);

    const resultPath = path.resolve(ROOT_DIR, '.funnel-state/evaluation-result.json');
    fs.writeFileSync(resultPath, JSON.stringify({
      date: formatDate(),
      experiment: exp.experiment_name,
      flag_key: exp.flag_key,
      decision: { action: 'killed', reason: 'Manual kill via --kill flag' },
    }, null, 2));

    console.log('Experiment killed and flag disabled.\nDone.');
    return;
  }

  const exp = state.active_experiment;
  const startDate = new Date(exp.started_at);
  const daysSinceStart = Math.floor((Date.now() - startDate.getTime()) / 86400000);

  console.log(`Experiment: ${exp.experiment_name}`);
  console.log(`  Flag: ${exp.flag_key}`);
  console.log(`  Started: ${exp.started_at} (${daysSinceStart} days ago)`);
  console.log(`  Target KPI: ${exp.target_kpi}`);

  // ─── Collect experiment data ───────────────────────────────────────────

  const targetConfig = config.optimization_targets.find(t => t.kpi === exp.target_kpi);
  if (!targetConfig) {
    console.error(`  Target KPI config not found: ${exp.target_kpi}`);
    process.exit(1);
  }

  const allEvents = [
    targetConfig.impression_event,
    ...targetConfig.click_events,
  ].map(e => `'${e}'`).join(', ');

  const dateFilter = `timestamp >= toDateTime('${exp.started_at}')`;
  const deviceWhere = targetConfig.device_filter
    ? `AND properties.$device_type = '${targetConfig.device_filter}'`
    : '';

  // Query variant-specific metrics using properly escaped property name
  const flagProp = `"$feature/${exp.flag_key}"`;
  const result = await posthog.hogql(`
    SELECT
      properties.${flagProp} as variant,
      event,
      count() as cnt,
      uniq(distinct_id) as users
    FROM events
    WHERE ${dateFilter}
      AND properties.${flagProp} IS NOT NULL
      AND event IN (${allEvents})
      ${deviceWhere}
    GROUP BY variant, event
    ORDER BY variant, event
  `, 'experiment_evaluation');

  if (!result.results.length) {
    // Fallback 1: try with explicit experiment_variant property (custom tracking)
    const fallback1 = await posthog.hogql(`
      SELECT
        properties.experiment_variant as variant,
        event,
        count() as cnt,
        uniq(distinct_id) as users
      FROM events
      WHERE ${dateFilter}
        AND properties.experiment_variant IS NOT NULL
        AND event IN (${allEvents})
        ${deviceWhere}
      GROUP BY variant, event
      ORDER BY variant, event
    `, 'experiment_evaluation_custom');

    if (fallback1.results.length) {
      result.results = fallback1.results;
      result.columns = fallback1.columns;
    }
  }

  if (!result.results.length) {
    // Fallback 2: join exposure events with KPI events by distinct_id
    const fallback2 = await posthog.hogql(`
      SELECT
        e2.properties."$feature_flag_response" as variant,
        e1.event as event,
        count() as cnt,
        uniq(e1.distinct_id) as users
      FROM events e1
      INNER JOIN (
        SELECT distinct_id, properties."$feature_flag_response" as variant
        FROM events
        WHERE event = '$experiment_exposure'
          AND properties."$feature_flag" = '${exp.flag_key}'
          AND ${dateFilter}
      ) e2 ON e1.distinct_id = e2.distinct_id
      WHERE e1.${dateFilter.replace('timestamp', 'e1.timestamp')}
        AND e1.event IN (${allEvents})
        ${deviceWhere.replace('properties.', 'e1.properties.')}
      GROUP BY variant, event
      ORDER BY variant, event
    `, 'experiment_evaluation_join');

    if (fallback2.results.length) {
      result.results = fallback2.results;
      result.columns = fallback2.columns;
    }
  }

  // ─── Parse results by variant (supports 2+ variants) ───────────────────

  const variantMap = {};
  for (const [variant, event, cnt, users] of result.results) {
    const vKey = String(variant || 'control').toLowerCase();
    if (!variantMap[vKey]) variantMap[vKey] = {};
    variantMap[vKey][event] = { cnt, users };
  }

  // Calculate CTR per variant
  function calcCTR(variantData) {
    const impressions = variantData[targetConfig.impression_event]?.cnt || 0;
    let clicks = 0;
    for (const ev of targetConfig.click_events) {
      clicks += variantData[ev]?.cnt || 0;
    }
    return {
      impressions,
      clicks,
      ctr: impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(4)) : 0,
    };
  }

  // Build metrics for all variants
  const variantKeys = Object.keys(variantMap).sort((a, b) => a === 'control' ? -1 : b === 'control' ? 1 : a.localeCompare(b));
  const allMetrics = {};
  let totalImpressions = 0;
  for (const vk of variantKeys) {
    allMetrics[vk] = calcCTR(variantMap[vk]);
    totalImpressions += allMetrics[vk].impressions;
  }

  // Backward-compatible: aggregate all test variants into a combined 'test' metric
  const controlMetrics = allMetrics.control || { impressions: 0, clicks: 0, ctr: 0 };
  const testVariantKeys = variantKeys.filter(k => k !== 'control');
  const testMetrics = {
    impressions: testVariantKeys.reduce((s, k) => s + allMetrics[k].impressions, 0),
    clicks: testVariantKeys.reduce((s, k) => s + allMetrics[k].clicks, 0),
    ctr: 0,
  };
  if (testMetrics.impressions > 0) {
    testMetrics.ctr = parseFloat((testMetrics.clicks / testMetrics.impressions * 100).toFixed(4));
  }
  const totalUsers = totalImpressions;

  console.log(`\nResults:`);
  for (const vk of variantKeys) {
    const m = allMetrics[vk];
    console.log(`  ${vk}: ${m.clicks}/${m.impressions} = ${m.ctr}%`);
  }
  console.log(`  Total impressions: ${totalUsers}`);

  // Warn about traffic allocation imbalance (multivariate)
  if (variantKeys.length > 2 && totalImpressions > 100) {
    const expectedShare = 1 / variantKeys.length;
    for (const vk of variantKeys) {
      const actualShare = allMetrics[vk].impressions / totalImpressions;
      if (actualShare < expectedShare * 0.3) {
        console.warn(`  ⚠ WARNING: ${vk} has only ${allMetrics[vk].impressions} impressions (${(actualShare * 100).toFixed(1)}%) — expected ~${(expectedShare * 100).toFixed(0)}%. Check PostHog flag allocation.`);
      }
    }
  }

  // ─── Decision logic (multivariate-aware, early decision support) ────────

  let decision;
  const minSample = config.automation.min_sample_size;
  const minEarlyDays = config.automation.min_early_decision_days || 3;
  const targetDays = config.automation.experiment_duration_days;
  const maxDays = config.automation.max_experiment_days || targetDays * 2;
  const sigLevel = config.automation.significance_level || 0.05;

  // Gate 1: Need minimum data before any decision
  if (totalUsers < minSample && daysSinceStart < maxDays) {
    decision = {
      action: 'continue',
      reason: `Insufficient data: ${totalUsers}/${minSample} impressions, ${daysSinceStart} days`,
    };
  } else if (daysSinceStart < minEarlyDays) {
    // Gate 2: Absolute minimum days (avoid novelty effects / day-of-week bias)
    decision = {
      action: 'continue',
      reason: `Minimum observation period: ${daysSinceStart}/${minEarlyDays} days`,
    };
  } else {
    // Compare each test variant against control individually
    const targetLift = exp.success_metric?.target_lift || 10;
    const perVariant = {};
    let bestVariant = null;
    let bestLift = -Infinity;

    for (const vk of testVariantKeys) {
      const vm = allMetrics[vk];
      const lift = controlMetrics.ctr > 0
        ? ((vm.ctr - controlMetrics.ctr) / controlMetrics.ctr * 100)
        : (vm.ctr > 0 ? Infinity : 0);
      const sig = calculateSignificance(
        controlMetrics.clicks, controlMetrics.impressions,
        vm.clicks, vm.impressions,
      );
      perVariant[vk] = { ctr: vm.ctr, lift: parseFloat(lift.toFixed(2)), pValue: sig.pValue, isSignificant: sig.isSignificant };
      console.log(`  ${vk} vs control: lift=${lift.toFixed(2)}%, p=${sig.pValue.toFixed(4)}, sig=${sig.isSignificant}`);

      if (lift > bestLift) {
        bestLift = lift;
        bestVariant = vk;
      }
    }

    // Also compute aggregate test vs control for backward compat
    const aggLift = controlMetrics.ctr > 0
      ? ((testMetrics.ctr - controlMetrics.ctr) / controlMetrics.ctr * 100).toFixed(2)
      : (testMetrics.ctr > 0 ? 'Infinity' : '0');
    const aggSig = calculateSignificance(
      controlMetrics.clicks, controlMetrics.impressions,
      testMetrics.clicks, testMetrics.impressions,
    );

    // Decision: use per-variant results if multivariate, else aggregate
    const isMultivariate = testVariantKeys.length > 1;
    const bestPerVariant = bestVariant ? perVariant[bestVariant] : null;

    if (isMultivariate && bestPerVariant) {
      if (bestPerVariant.isSignificant && bestPerVariant.lift >= targetLift) {
        decision = {
          action: 'winner_test',
          reason: `${bestVariant} wins: +${bestPerVariant.lift}% lift vs control (p=${bestPerVariant.pValue.toFixed(4)})`,
          winner: bestVariant,
          per_variant: perVariant,
        };
      } else if (Object.values(perVariant).every(v => v.isSignificant && v.lift <= -targetLift)) {
        decision = {
          action: 'winner_control',
          reason: `All test variants significantly worse than control`,
          winner: 'control',
          per_variant: perVariant,
        };
      } else if (daysSinceStart >= maxDays) {
        decision = {
          action: 'winner_control',
          reason: `No significant winner after ${daysSinceStart} days. Keeping control.`,
          winner: 'control',
          per_variant: perVariant,
        };
      } else {
        decision = {
          action: 'continue',
          reason: `Not yet significant. Best: ${bestVariant} (lift=${bestPerVariant.lift}%, p=${bestPerVariant.pValue.toFixed(4)})`,
          per_variant: perVariant,
        };
      }
    } else {
      // 2-variant fallback (original logic)
      const lift = aggLift;
      const significance = aggSig;

      if (significance.isSignificant && parseFloat(lift) >= targetLift) {
        decision = {
          action: 'winner_test',
          reason: `Test variant wins: +${lift}% lift (p=${significance.pValue.toFixed(4)})`,
          winner: testVariantKeys[0] || 'test',
        };
      } else if (significance.isSignificant && parseFloat(lift) <= -targetLift) {
        decision = {
          action: 'winner_control',
          reason: `Control variant wins: test is ${lift}% worse (p=${significance.pValue.toFixed(4)})`,
          winner: 'control',
        };
      } else if (daysSinceStart >= maxDays) {
        decision = {
          action: 'winner_control',
          reason: `No significant difference after ${daysSinceStart} days. Keeping control.`,
          winner: 'control',
        };
      } else {
        decision = {
          action: 'continue',
          reason: `Not yet significant (p=${significance.pValue.toFixed(4)}), lift=${lift}%`,
        };
      }
    }
  }

  console.log(`\nDecision: ${decision.action}`);
  console.log(`  Reason: ${decision.reason}`);

  // ─── Apply decision ────────────────────────────────────────────────────

  if (decision.action === 'winner_test' || decision.action === 'winner_control') {
    console.log(`\nFinalizing experiment...`);

    // Record in history
    state.history = state.history || [];
    state.history.push({
      ...exp,
      ended_at: new Date().toISOString(),
      result: {
        winner: decision.winner,
        control_ctr: controlMetrics.ctr,
        test_ctr: testMetrics.ctr,
        total_impressions: totalUsers,
        days_run: daysSinceStart,
      },
    });

    // Clean up code: remove feature flag wrapper, keep winner code
    if (exp.code_changes) {
      console.log('  Cleaning up feature flag code...');
      // Note: actual code cleanup is complex and done in a separate step
      // For now, we document what needs to be done
      decision.cleanup_needed = exp.code_changes.map(c => ({
        file: c.file,
        flag_key: exp.flag_key,
        keep: decision.winner,
      }));
    }

    // Disable feature flag
    let flagDisabled = false;
    try {
      if (exp.flag_id) {
        await posthog.updateFeatureFlag(exp.flag_id, { active: false });
        console.log(`  Feature flag ${exp.flag_key} disabled.`);
        flagDisabled = true;
      }
    } catch (err) {
      console.log(`  Warning: Could not disable flag: ${err.message}`);
    }

    // Record flag_disabled_at in history
    if (flagDisabled && state.history.length > 0) {
      state.history[state.history.length - 1].flag_disabled_at = formatDate();
    }

    state.active_experiment = null;
    saveState(state);
  }

  // Save evaluation result
  const resultPath = path.resolve(ROOT_DIR, '.funnel-state/evaluation-result.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    date: formatDate(),
    experiment: exp.experiment_name,
    flag_key: exp.flag_key,
    metrics: {
      control: controlMetrics,
      test: testMetrics,
      per_variant: allMetrics,
      total_impressions: totalUsers,
      days_run: daysSinceStart,
    },
    decision,
  }, null, 2));

  console.log('\nDone.');
}

// ─── Statistics ──────────────────────────────────────────────────────────────

function calculateSignificance(clicksA, impressionsA, clicksB, impressionsB) {
  // Two-proportion z-test
  if (impressionsA === 0 || impressionsB === 0) {
    return { zScore: 0, pValue: 1, isSignificant: false };
  }

  const pA = clicksA / impressionsA;
  const pB = clicksB / impressionsB;
  const pPooled = (clicksA + clicksB) / (impressionsA + impressionsB);

  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / impressionsA + 1 / impressionsB));

  if (se === 0) {
    return { zScore: 0, pValue: 1, isSignificant: false };
  }

  const zScore = (pB - pA) / se;
  // Two-tailed p-value approximation
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));

  return {
    zScore: parseFloat(zScore.toFixed(4)),
    pValue: parseFloat(pValue.toFixed(6)),
    isSignificant: pValue < 0.05,
  };
}

function normalCDF(x) {
  // Approximation of the standard normal CDF
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
