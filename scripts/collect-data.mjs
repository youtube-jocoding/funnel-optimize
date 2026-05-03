#!/usr/bin/env node

/**
 * Step 1: Collect data from PostHog and git for weekly analysis.
 *
 * Usage:
 *   node scripts/funnel-automation/collect-data.mjs --days 7
 *
 * Output: .funnel-state/weekly-snapshot-{date}.json
 */

import fs from 'fs';
import path from 'path';
import {
  loadEnv, createPostHogClient, loadConfig, getGitChanges,
  loadState, saveState, formatDate, daysAgo, ROOT_DIR,
} from './lib.mjs';

loadEnv();

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let DAYS = 7;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) { DAYS = parseInt(args[i + 1], 10); i++; }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Funnel Automation: Data Collection (${DAYS} days) ===\n`);

  const config = loadConfig();
  const posthog = createPostHogClient();
  const state = loadState();
  const dateFilter = `timestamp >= now() - toIntervalDay(${DAYS})`;

  // 1. Core funnel metrics
  console.log('1/4 Collecting funnel metrics...');
  const funnelQueries = {
    funnel: {
      name: 'funnel_steps',
      query: (() => {
        const steps = (config.funnel?.steps || ['$pageview']).map(e => `'${e}'`).join(', ');
        return `
          SELECT event as step, uniqHLL12(distinct_id) as users
          FROM events
          WHERE event IN (${steps})
            AND ${dateFilter}
          GROUP BY event
        `;
      })(),
    },
    dailyTraffic: {
      name: 'daily_traffic',
      query: `
        SELECT toDate(timestamp) as day, count() as pageviews, uniqHLL12(distinct_id) as uv
        FROM events WHERE event = '$pageview' AND ${dateFilter}
        GROUP BY day ORDER BY day ASC
        LIMIT 30
      `,
    },
    eventSummary: {
      name: 'event_summary',
      query: `
        SELECT event, count() as cnt, uniq(distinct_id) as users
        FROM events WHERE ${dateFilter}
        GROUP BY event ORDER BY cnt DESC LIMIT 50
      `,
    },
  };

  // 2. KPI-specific metrics based on config targets
  console.log('2/4 Collecting KPI metrics...');
  const kpiQueries = {};
  for (const target of config.optimization_targets) {
    const allEvents = [target.impression_event, ...target.click_events].map(e => `'${e}'`).join(', ');
    const deviceWhere = target.device_filter ? `AND properties.$device_type = '${target.device_filter}'` : '';

    kpiQueries[target.kpi] = {
      name: `kpi_${target.kpi}`,
      query: `
        SELECT event, count() as cnt, uniq(distinct_id) as users
        FROM events
        WHERE event IN (${allEvents}) AND ${dateFilter} ${deviceWhere}
        GROUP BY event
      `,
    };
  }

  // Additional metrics for context
  // checkout error events are configurable
  const checkoutEvents = config.checkout_error_events || null;
  if (checkoutEvents && checkoutEvents.success && checkoutEvents.error) {
    kpiQueries.checkoutErrors = {
      name: 'checkout_errors',
      query: `
        SELECT event, count() as cnt
        FROM events
        WHERE event IN ('${checkoutEvents.success}', '${checkoutEvents.error}') AND ${dateFilter}
        GROUP BY event
      `,
    };
  }

  kpiQueries.deviceBreakdown = {
    name: 'device_breakdown',
    query: (() => {
      const events = new Set(['$pageview']);
      for (const t of config.optimization_targets || []) {
        events.add(t.impression_event);
        for (const ev of t.click_events) events.add(ev);
      }
      const eventList = [...events].map(e => `'${e}'`).join(', ');
      return `
        SELECT properties.$device_type as device, event, uniq(distinct_id) as users
        FROM events
        WHERE event IN (${eventList}) AND ${dateFilter}
        GROUP BY device, event
      `;
    })(),
  };

  kpiQueries.languageBreakdown = {
    name: 'language_breakdown',
    query: (() => {
      const langEvents = (config.funnel?.steps || []).slice(1, 4).map(e => `'${e}'`).join(', ') || `'$pageview'`;
      return `
        SELECT properties.lang as lang, count() as cnt, uniq(distinct_id) as users
        FROM events
        WHERE event IN (${langEvents}) AND ${dateFilter}
          AND properties.lang IS NOT NULL
        GROUP BY lang ORDER BY users DESC
      `;
    })(),
  };

  kpiQueries.referrerSources = {
    name: 'referrer_sources',
    query: `
      SELECT properties.$referrer as referrer, uniq(distinct_id) as users
      FROM events
      WHERE event = '$pageview' AND ${dateFilter}
        AND properties.$referrer IS NOT NULL AND properties.$referrer != ''
      GROUP BY referrer ORDER BY users DESC LIMIT 15
    `,
  };

  // 2.5 Value Metrics (LIR, Time-to-Value, Health Rollup)
  console.log('2.5/4 Collecting value metrics (LIR, TTV, Health Rollup)...');
  const valueMetrics = config.value_metrics || {};

  // LIR: Leading Indicator of Retention
  if (valueMetrics.lir) {
    const lirEvents = valueMetrics.lir.events.map(e => `'${e}'`).join(', ');
    kpiQueries.lir = {
      name: 'lir',
      query: `
        SELECT
          uniq(distinct_id) as result_viewers,
          uniqIf(distinct_id, event IN (${lirEvents})) as activated_users
        FROM events
        WHERE ${dateFilter}
          AND event IN ('${valueMetrics.lir.denominator_event}', ${lirEvents})
      `,
    };
  }

  // Time-to-Value: Median time between funnel steps per user
  if (valueMetrics.time_to_value) {
    for (const [key, milestone] of Object.entries(valueMetrics.time_to_value.milestones)) {
      kpiQueries[`ttv_${key}`] = {
        name: `ttv_${key}`,
        query: `
          SELECT
            quantile(0.5)(time_diff) as median_seconds,
            quantile(0.25)(time_diff) as p25_seconds,
            quantile(0.75)(time_diff) as p75_seconds,
            avg(time_diff) as avg_seconds,
            count() as sample_size
          FROM (
            SELECT
              s.distinct_id,
              dateDiff('second',
                min(s.timestamp),
                min(e.timestamp)
              ) as time_diff
            FROM events s
            INNER JOIN events e ON s.distinct_id = e.distinct_id
            WHERE s.event = '${milestone.start}'
              AND e.event = '${milestone.end}'
              AND s.timestamp >= now() - toIntervalDay(${DAYS})
              AND e.timestamp >= now() - toIntervalDay(${DAYS})
              AND e.timestamp > s.timestamp
              AND e.timestamp < s.timestamp + toIntervalHour(1)
            GROUP BY s.distinct_id
          )
        `,
      };
    }
  }

  // Health Rollup: User segment counts
  if (valueMetrics.health_rollup) {
    const hr = valueMetrics.health_rollup;
    const uploadEvent = hr.upload_event || (config.funnel?.steps || [])[1] || '$pageview';
    const resultEvent = hr.result_event || (config.funnel?.steps || [])[3] || '$pageview';
    // Prefer explicit hr.action_events. Fall back to LIR events (activation actions by definition).
    // Last resort: funnel.steps.slice(4), but this often misclassifies passive redirects as actions.
    const actionEvents = hr.action_events
      || valueMetrics.lir?.events
      || (config.funnel?.steps || []).slice(4);
    const actionEventList = actionEvents.map(e => `'${e}'`).join(', ') || `'$pageview'`;
    const allHrEvents = ['$pageview', uploadEvent, resultEvent, ...actionEvents];
    const allHrEventList = [...new Set(allHrEvents)].map(e => `'${e}'`).join(', ');
    kpiQueries.healthRollup = {
      name: 'health_rollup',
      query: `
        SELECT
          uniqIf(distinct_id, has_result AND has_action) as activated,
          uniqIf(distinct_id, has_result AND NOT has_action) as completed,
          uniqIf(distinct_id, has_upload AND NOT has_result) as stuck,
          uniqIf(distinct_id, NOT has_upload) as bounced,
          uniq(distinct_id) as total
        FROM (
          SELECT
            distinct_id,
            countIf(event = '${uploadEvent}') > 0 as has_upload,
            countIf(event = '${resultEvent}') > 0 as has_result,
            countIf(event IN (${actionEventList})) > 0 as has_action
          FROM events
          WHERE ${dateFilter}
            AND event IN (${allHrEventList})
          GROUP BY distinct_id
        )
      `,
    };
  }

  // 3. Active experiment data
  console.log('3/4 Collecting experiment data...');
  let activeExperiments = [];
  let experimentResults = {};

  if (state.active_experiment) {
    const flagKey = state.active_experiment.flag_key;
    // Collect variant-specific metrics
    const flagProp = `"$feature/${flagKey}"`;
    kpiQueries.experimentVariants = {
      name: 'experiment_variants',
      query: `
        SELECT
          coalesce(properties.${flagProp}, properties.experiment_variant) as variant,
          event,
          count() as cnt,
          uniq(distinct_id) as users
        FROM events
        WHERE ${dateFilter}
          AND (properties.${flagProp} IS NOT NULL OR properties.experiment_variant IS NOT NULL)
          AND event IN (${config.optimization_targets.map(t =>
            [t.impression_event, ...t.click_events].map(e => `'${e}'`)).flat().join(', ')})
        GROUP BY variant, event
        ORDER BY variant, event
      `,
    };
  }

  try {
    activeExperiments = await posthog.listExperiments();
    activeExperiments = activeExperiments.filter(e => e.start_date && !e.end_date);
  } catch (err) {
    console.log(`  (experiments API not available: ${err.message})`);
  }

  // Execute all queries
  const allQueries = { ...funnelQueries, ...kpiQueries };
  const results = await posthog.hogqlBatch(allQueries);

  // 4. Git changes
  console.log('4/4 Collecting git changes...');
  let gitChanges;
  try {
    gitChanges = await getGitChanges(DAYS);
  } catch {
    gitChanges = { log: '', diffStat: '', changedFiles: [] };
  }

  // ─── Compute KPI values ──────────────────────────────────────────────────

  const kpiValues = {};
  for (const target of config.optimization_targets) {
    const data = results[target.kpi];
    if (!data || !data.results.length) {
      kpiValues[target.kpi] = { impressions: 0, clicks: 0, ctr: 0 };
      continue;
    }
    let impressions = 0, clicks = 0;
    for (const [event, cnt] of data.results) {
      if (event === target.impression_event) impressions = cnt;
      if (target.click_events.includes(event)) clicks += cnt;
    }
    kpiValues[target.kpi] = {
      impressions,
      clicks,
      ctr: impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0,
      target_ctr: target.target,
      gap: impressions > 0 ? parseFloat((target.target - clicks / impressions * 100).toFixed(2)) : target.target,
    };
  }

  // Checkout error rate (configurable)
  const checkoutData = results.checkoutErrors;
  let checkoutErrorRate = 0;
  if (checkoutEvents && checkoutData && checkoutData.results.length) {
    let total = 0, errors = 0;
    for (const [event, cnt] of checkoutData.results) {
      if (event === checkoutEvents.success) total = cnt;
      if (event === checkoutEvents.error) errors = cnt;
    }
    checkoutErrorRate = total > 0 ? parseFloat((errors / total * 100).toFixed(2)) : 0;
  }

  // ─── Compute Value Metrics ─────────────────────────────────────────────

  const valueMetricValues = {};

  // LIR
  if (results.lir && results.lir.results.length) {
    const [resultViewers, activatedUsers] = results.lir.results[0];
    valueMetricValues.lir = {
      result_viewers: resultViewers,
      activated_users: activatedUsers,
      rate: resultViewers > 0 ? parseFloat((activatedUsers / resultViewers * 100).toFixed(2)) : 0,
      target_rate: config.value_metrics?.lir?.target_rate || 15,
    };
  }

  // Time-to-Value
  const ttvMilestones = config.value_metrics?.time_to_value?.milestones || {};
  const ttvValues = {};
  for (const key of Object.keys(ttvMilestones)) {
    const data = results[`ttv_${key}`];
    if (data && data.results.length) {
      const [median, p25, p75, avg, sampleSize] = data.results[0];
      ttvValues[key] = {
        median_seconds: parseFloat(Number(median).toFixed(1)),
        p25_seconds: parseFloat(Number(p25).toFixed(1)),
        p75_seconds: parseFloat(Number(p75).toFixed(1)),
        avg_seconds: parseFloat(Number(avg).toFixed(1)),
        sample_size: sampleSize,
        target_seconds: ttvMilestones[key].target_seconds,
        description: ttvMilestones[key].description,
      };
    }
  }
  if (Object.keys(ttvValues).length) valueMetricValues.time_to_value = ttvValues;

  // Health Rollup
  if (results.healthRollup && results.healthRollup.results.length) {
    const [activated, completed, stuck, bounced, total] = results.healthRollup.results[0];
    valueMetricValues.health_rollup = {
      activated, completed, stuck, bounced, total,
      rates: {
        activated: total > 0 ? parseFloat((activated / total * 100).toFixed(1)) : 0,
        completed: total > 0 ? parseFloat((completed / total * 100).toFixed(1)) : 0,
        stuck: total > 0 ? parseFloat((stuck / total * 100).toFixed(1)) : 0,
        bounced: total > 0 ? parseFloat((bounced / total * 100).toFixed(1)) : 0,
      },
    };
  }

  // ─── Build snapshot ──────────────────────────────────────────────────────

  const snapshot = {
    meta: {
      generated_at: new Date().toISOString(),
      period_days: DAYS,
      period_start: daysAgo(DAYS),
      period_end: formatDate(),
    },
    kpi: kpiValues,
    checkout_error_rate: checkoutErrorRate,
    funnel: results.funnel,
    daily_traffic: results.dailyTraffic,
    event_summary: results.eventSummary,
    device_breakdown: results.deviceBreakdown,
    language_breakdown: results.languageBreakdown,
    referrer_sources: results.referrerSources,
    git_changes: gitChanges,
    active_experiments: activeExperiments.map(e => ({
      id: e.id,
      name: e.name,
      feature_flag_key: e.feature_flag?.key,
      start_date: e.start_date,
    })),
    experiment_variants: results.experimentVariants || null,
    value_metrics: valueMetricValues,
    state: state,
  };

  // ─── Save snapshot ───────────────────────────────────────────────────────

  const stateDir = path.resolve(ROOT_DIR, '.funnel-state');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  const snapshotPath = path.resolve(stateDir, `weekly-snapshot-${formatDate()}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  // Also save as latest for next step
  const latestPath = path.resolve(stateDir, 'latest-snapshot.json');
  fs.writeFileSync(latestPath, JSON.stringify(snapshot, null, 2));

  // Update state
  state.last_run = new Date().toISOString();
  saveState(state);

  console.log(`\nSnapshot saved: ${snapshotPath}`);
  console.log('KPI Summary:');
  for (const [kpi, val] of Object.entries(kpiValues)) {
    const target = config.optimization_targets.find(t => t.kpi === kpi);
    const status = val.ctr >= target.target ? 'PASS' : val.ctr > target.current ? 'UP' : 'MISS';
    console.log(`  ${target.metric_name}: ${val.ctr}% (target: ${target.target}%) [${status}]`);
  }
  console.log(`  Checkout Error Rate: ${checkoutErrorRate}%`);

  // Value Metrics Summary
  if (valueMetricValues.lir) {
    console.log(`  LIR Rate: ${valueMetricValues.lir.rate}% (target: ${valueMetricValues.lir.target_rate}%)`);
  }
  if (valueMetricValues.time_to_value) {
    for (const [key, ttv] of Object.entries(valueMetricValues.time_to_value)) {
      console.log(`  TTV ${ttv.description || key} (median): ${ttv.median_seconds}s (target: ${ttv.target_seconds}s)`);
    }
  }
  if (valueMetricValues.health_rollup) {
    const hr = valueMetricValues.health_rollup;
    console.log(`  Health Rollup: activated ${hr.rates.activated}% | completed ${hr.rates.completed}% | stuck ${hr.rates.stuck}% | bounced ${hr.rates.bounced}%`);
  }
  console.log('\nDone.');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
