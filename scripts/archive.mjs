#!/usr/bin/env node

/**
 * Archive weekly funnel optimization results.
 *
 * Creates:
 *   docs/funnel-archive/YYYY-MM-DD.md   — Human-readable weekly report
 *   docs/funnel-archive/index.md        — Updated index of all reports
 *
 * Usage:
 *   node scripts/funnel-automation/archive.mjs
 */

import fs from 'fs';
import path from 'path';
import { loadEnv, loadConfig, loadState, ROOT_DIR, formatDate } from './lib.mjs';
import { spawnSync } from 'node:child_process';

loadEnv();

const ARCHIVE_DIR = path.resolve(ROOT_DIR, 'docs/funnel-archive');

async function main() {
  console.log('\n=== Funnel Automation: Archive ===\n');

  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const config = loadConfig();
  const state = loadState();
  const today = formatDate();

  // Load latest snapshot
  const snapshotPath = path.resolve(ROOT_DIR, '.funnel-state/latest-snapshot.json');
  if (!fs.existsSync(snapshotPath)) {
    console.log('No snapshot to archive.');
    return;
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));

  // Load evaluation result
  const evalPath = path.resolve(ROOT_DIR, '.funnel-state/evaluation-result.json');
  const evalResult = fs.existsSync(evalPath) ? JSON.parse(fs.readFileSync(evalPath, 'utf-8')) : null;

  // Load experiment plan
  const planPath = path.resolve(ROOT_DIR, '.funnel-state/experiment-plan.json');
  const plan = fs.existsSync(planPath) ? JSON.parse(fs.readFileSync(planPath, 'utf-8')) : null;

  // Load implementation summary
  const implPath = path.resolve(ROOT_DIR, '.funnel-state/implementation-summary.json');
  const implSummary = fs.existsSync(implPath) ? JSON.parse(fs.readFileSync(implPath, 'utf-8')) : null;

  // ─── Generate weekly report markdown ───────────────────────────────────

  const report = generateReport({
    date: today,
    snapshot,
    config,
    state,
    evalResult,
    plan,
    implSummary,
  });

  const reportPath = path.resolve(ARCHIVE_DIR, `${today}.md`);
  fs.writeFileSync(reportPath, report);
  console.log(`Archived: ${reportPath}`);

  // ─── Update index ──────────────────────────────────────────────────────

  updateIndex();
  console.log('Index updated.');

  // Refresh the visual dashboard (best-effort; archive shouldn't fail because of it).
  console.log('Rendering dashboard...');
  const r = spawnSync(process.execPath, ['scripts/render-dashboard.mjs'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.log('  (dashboard render failed; continuing — see error above)');
  }

  console.log('\nDone.');
}

function generateReport({ date, snapshot, config, state, evalResult, plan, implSummary }) {
  const meta = snapshot.meta;
  const kpi = snapshot.kpi;

  let md = `# Weekly Funnel Report — ${date}\n\n`;
  md += `> Period: ${meta.period_start} ~ ${meta.period_end} (${meta.period_days} days)\n`;
  md += `> Generated: ${meta.generated_at}\n\n`;

  // ─── KPI Dashboard ─────────────────────────────────────────────────────

  md += `## KPI Dashboard\n\n`;
  md += `| KPI | Current | Target | Gap | Status |\n`;
  md += `|-----|---------|--------|-----|--------|\n`;

  for (const target of config.optimization_targets) {
    const data = kpi[target.kpi];
    if (!data) continue;
    const current = `${data.ctr}%`;
    const targetVal = `${target.target}%`;
    const gap = data.gap !== undefined ? `${data.gap > 0 ? '+' : ''}${data.gap}%` : '-';
    let status;
    if (data.ctr >= target.target) {
      status = 'PASS';
    } else if (data.ctr > target.current) {
      status = 'UP';
    } else {
      status = 'MISS';
    }
    md += `| ${target.metric_name} | ${current} | ${targetVal} | ${gap} | ${status} |\n`;
  }

  md += `| Checkout Error Rate | ${snapshot.checkout_error_rate}% | <5% | - | ${snapshot.checkout_error_rate < 5 ? 'PASS' : 'MISS'} |\n`;
  md += `\n`;

  // ─── Funnel ────────────────────────────────────────────────────────────

  if (snapshot.funnel && snapshot.funnel.results) {
    md += `## Funnel Conversion\n\n`;
    md += `| Step | Users | Rate |\n`;
    md += `|------|-------|------|\n`;

    const funnelMap = {};
    for (const [step, users] of snapshot.funnel.results) {
      funnelMap[step] = users;
    }

    // Use config-driven step order; fall back to whatever results came back
    const configSteps = config.funnel?.steps || Object.keys(funnelMap);
    // Baseline = count of the first step (avoids "|| 1" producing 525700% when pageview is absent)
    const firstStepCount = funnelMap[configSteps[0]];
    const total = (firstStepCount && firstStepCount > 1) ? firstStepCount : null;

    for (const step of configSteps) {
      const users = funnelMap[step] || 0;
      if (users === 0) continue;
      // Only show rate when we have a meaningful baseline; otherwise show '-'
      const rate = (total !== null) ? `${((users / total) * 100).toFixed(1)}%` : '-';
      md += `| ${step} | ${users.toLocaleString()} | ${rate} |\n`;
    }
    md += `\n`;
  }

  // ─── Traffic ───────────────────────────────────────────────────────────

  if (snapshot.daily_traffic && snapshot.daily_traffic.results) {
    md += `## Daily Traffic\n\n`;
    md += `| Date | PV | UV |\n`;
    md += `|------|----|----|\n`;
    for (const [day, pv, uv] of snapshot.daily_traffic.results) {
      md += `| ${day} | ${Number(pv).toLocaleString()} | ${Number(uv).toLocaleString()} |\n`;
    }
    md += `\n`;
  }

  // ─── Previous Experiment Results ───────────────────────────────────────

  if (evalResult && evalResult.action !== 'none') {
    md += `## Previous Experiment Evaluation\n\n`;
    md += `- **Experiment**: ${evalResult.experiment || 'N/A'}\n`;
    md += `- **Flag**: \`${evalResult.flag_key || 'N/A'}\`\n`;
    md += `- **Decision**: ${evalResult.decision?.action || 'N/A'}\n`;
    md += `- **Reason**: ${evalResult.decision?.reason || 'N/A'}\n`;

    if (evalResult.metrics) {
      const m = evalResult.metrics;
      md += `\n| Variant | Impressions | Clicks | CTR |\n`;
      md += `|---------|------------|--------|-----|\n`;
      md += `| Control | ${m.control?.impressions || 0} | ${m.control?.clicks || 0} | ${m.control?.ctr || 0}% |\n`;
      md += `| Test | ${m.test?.impressions || 0} | ${m.test?.clicks || 0} | ${m.test?.ctr || 0}% |\n`;
    }
    md += `\n`;
  }

  // ─── New Experiment Plan ───────────────────────────────────────────────

  if (plan && plan.action !== 'error' && plan.experiment_name) {
    md += `## New Experiment\n\n`;
    md += `- **Name**: ${plan.experiment_name}\n`;
    md += `- **Target KPI**: ${plan.target_kpi}\n`;
    md += `- **Hypothesis**: ${plan.hypothesis}\n`;
    md += `- **Flag**: \`${plan.flag_key}\`\n`;
    md += `- **Action**: ${plan.action}\n`;

    if (plan.variant_description) {
      md += `\n| Variant | Description |\n`;
      md += `|---------|-------------|\n`;
      md += `| Control | ${plan.variant_description.control} |\n`;
      md += `| Test | ${plan.variant_description.test} |\n`;
    }

    if (plan._guardrail_violations) {
      md += `\n**Guardrail Violations:**\n`;
      for (const v of plan._guardrail_violations) {
        md += `- ${v}\n`;
      }
    }
    md += `\n`;
  }

  // ─── Implementation Summary ────────────────────────────────────────────

  if (implSummary && implSummary.applied_changes?.length > 0) {
    md += `## Implementation\n\n`;
    md += `| File | Change |\n`;
    md += `|------|--------|\n`;
    for (const change of implSummary.applied_changes) {
      md += `| \`${change.file}\` | ${change.description} |\n`;
    }
    md += `\n`;
  }

  // ─── Git Changes ──────────────────────────────────────────────────────

  if (snapshot.git_changes && snapshot.git_changes.log) {
    md += `## Git Changes This Week\n\n`;
    md += `\`\`\`\n${snapshot.git_changes.log}\n\`\`\`\n\n`;
  }

  // ─── Experiment History ────────────────────────────────────────────────

  if (state.history && state.history.length > 0) {
    md += `## Experiment History\n\n`;
    md += `| # | Name | KPI | Winner | Control CTR | Test CTR | Days |\n`;
    md += `|---|------|-----|--------|-------------|----------|------|\n`;
    for (let i = 0; i < state.history.length; i++) {
      const h = state.history[i];
      const r = h.result || {};
      md += `| ${i + 1} | ${h.experiment_name || 'N/A'} | ${h.target_kpi || '-'} | ${r.winner || h.ended_reason || '-'} | ${r.control_ctr || '-'}% | ${r.test_ctr || '-'}% | ${r.days_run || '-'} |\n`;
    }
    md += `\n`;
  }

  md += `---\n\n*Generated by Funnel Optimization Automation*\n`;
  return md;
}

function updateIndex() {
  // Scan archive directory for all .md files (except index.md)
  const files = fs.readdirSync(ARCHIVE_DIR)
    .filter(f => f.endsWith('.md') && f !== 'index.md')
    .sort()
    .reverse();

  let index = `# Funnel Optimization Archive\n\n`;
  index += `Total reports: ${files.length}\n\n`;
  index += `| Date | Report |\n`;
  index += `|------|--------|\n`;

  for (const file of files) {
    const date = file.replace('.md', '');
    index += `| ${date} | [View](${file}) |\n`;
  }

  index += `\n---\n\n`;
  index += `*This index is auto-generated. Do not edit manually.*\n`;

  fs.writeFileSync(path.resolve(ARCHIVE_DIR, 'index.md'), index);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
