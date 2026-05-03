#!/usr/bin/env node

/**
 * feedback-loop.mjs — Experiment outcome feedback pipeline
 *
 * CLI modes:
 *   --ingest                  Read evaluation-result.json + experiment-plan.json, append to patterns.json
 *   --ingest --seed           Bootstrap patterns.json from FUNNEL_STATUS.md experiment history table
 *   --format prompt           Read patterns.json, generate markdown for agent prompt injection (500 word max, 90-day TTL)
 *   --summary                 Show counts of success/failure patterns and meta-learnings
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROOT_DIR, loadState } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(ROOT_DIR, '.funnel-state');
const DEFAULT_PATTERNS_PATH = path.resolve(STATE_DIR, 'patterns.json');
const FUNNEL_STATUS_PATH = path.resolve(ROOT_DIR, 'FUNNEL_STATUS.md');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function daysBetween(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function loadPatterns(patternsPath) {
  if (!fs.existsSync(patternsPath)) return null;

  const raw = fs.readFileSync(patternsPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    // Malformed JSON — backup and create fresh
    const backupPath = `${patternsPath}.corrupt.${Date.now()}`;
    fs.writeFileSync(backupPath, raw);
    console.error(`[feedback-loop] Malformed patterns.json backed up to ${backupPath}`);
    return null;
  }
}

function emptyPatterns() {
  return {
    version: 1,
    last_updated: today(),
    experiments_total: 0,
    success_patterns: [],
    failure_patterns: [],
    meta_learnings: [],
  };
}

function savePatterns(patternsPath, patterns) {
  const dir = path.dirname(patternsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  patterns.last_updated = today();
  fs.writeFileSync(patternsPath, JSON.stringify(patterns, null, 2));
}

// ─── Core exports ─────────────────────────────────────────────────────────────

/**
 * Ingest an experiment outcome into patterns.json.
 *
 * @param {object} evalResult  - Contents of evaluation-result.json (must have .action)
 * @param {object} plan        - Contents of experiment-plan.json
 * @param {string} patternsPath - Path to patterns.json
 */
export function ingestPattern(evalResult, plan, patternsPath = DEFAULT_PATTERNS_PATH) {
  const { action, reason, lift } = evalResult || {};

  // Determine decision
  let decision;
  if (action === 'winner_test') {
    decision = 'ship';
  } else if (action === 'winner_control') {
    decision = 'kill';
  } else {
    // none / continue / other → skip
    return;
  }

  const patterns = loadPatterns(patternsPath) || emptyPatterns();

  const base = {
    experiment: plan.flag_key || plan.experiment_id || 'unknown',
    decision,
    date: today(),
    target_kpi: plan.target_kpi || '',
    hypothesis_type: plan.assumption_category || '',
    hypothesis: plan.hypothesis || '',
    actual_lift: lift || (decision === 'ship' ? 'unknown' : 'N/A'),
    code_pattern: Array.isArray(plan.code_changes) && plan.code_changes.length > 0
      ? plan.code_changes.map(c => c.description || c.file || '').filter(Boolean).join('; ')
      : '',
    insight: reason || '',
  };

  if (decision === 'ship') {
    patterns.success_patterns.push({
      ...base,
      what_worked: base.code_pattern || reason || '',
    });
  } else {
    patterns.failure_patterns.push({
      ...base,
      what_failed: base.code_pattern || reason || '',
    });
  }

  patterns.experiments_total = (patterns.experiments_total || 0) + 1;
  savePatterns(patternsPath, patterns);
}

/**
 * Generate markdown prompt injection text from patterns.json.
 * Filters to 90-day TTL, caps at 5+5 patterns and 500 words.
 *
 * @param {string} patternsPath
 * @returns {string} Korean markdown or empty string
 */
export function formatPrompt(patternsPath = DEFAULT_PATTERNS_PATH) {
  const patterns = loadPatterns(patternsPath);
  if (!patterns) return '';

  const TTL_DAYS = 90;

  const recentSuccess = (patterns.success_patterns || [])
    .filter(p => daysBetween(p.date) <= TTL_DAYS)
    .slice(-5);

  const recentFailure = (patterns.failure_patterns || [])
    .filter(p => daysBetween(p.date) <= TTL_DAYS)
    .slice(-5);

  const metaLearnings = patterns.meta_learnings || [];

  // If nothing to show, return empty
  if (recentSuccess.length === 0 && recentFailure.length === 0 && metaLearnings.length === 0) {
    return '';
  }

  const lines = [];
  lines.push('## 과거 실험 학습 (자동 주입)');
  lines.push('');

  if (recentSuccess.length > 0) {
    lines.push('### 성공 패턴');
    for (const p of recentSuccess) {
      lines.push(`- **${p.experiment}** (${p.date}): ${p.what_worked || p.insight || ''} — lift: ${p.actual_lift || '?'}`);
    }
    lines.push('');
  }

  if (recentFailure.length > 0) {
    lines.push('### 실패 패턴');
    for (const p of recentFailure) {
      lines.push(`- **${p.experiment}** (${p.date}): ${p.what_failed || p.insight || ''}`);
    }
    lines.push('');
  }

  if (metaLearnings.length > 0) {
    lines.push('### 핵심 규칙');
    for (const l of metaLearnings) {
      lines.push(`- ${l}`);
    }
    lines.push('');
  }

  // Cap at 500 words
  const text = lines.join('\n');
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 500) {
    return words.slice(0, 500).join(' ');
  }
  return text;
}

/**
 * Bootstrap patterns.json from FUNNEL_STATUS.md experiment history table.
 * Skips if patterns.json already exists.
 *
 * @param {string} statusContent  - Contents of FUNNEL_STATUS.md
 * @param {Array}  stateHistory   - .funnel-state/state.json history array (unused but accepted)
 * @param {string} patternsPath
 */
export function seedFromHistory(statusContent, stateHistory, patternsPath = DEFAULT_PATTERNS_PATH) {
  // Skip if already exists
  if (fs.existsSync(patternsPath)) return;

  const patterns = emptyPatterns();

  // Parse markdown table rows — format:
  // | # | 실험명 | KPI | 가설 유형 | 결정 | Control | Test | 기간 | 학습 |
  const rowRegex = /\|\s*\d+\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g;

  let match;
  while ((match = rowRegex.exec(statusContent)) !== null) {
    const name = match[1].trim();
    const kpi = match[2].trim();
    const hypothesisType = match[3].trim();
    const decisionRaw = match[4].trim();
    const control = match[5].trim();
    const test = match[6].trim();
    // const duration = match[7].trim();
    const learning = match[8].trim();

    // Determine decision
    let decision;
    const dl = decisionRaw.toLowerCase();
    if (dl.includes('ship') || dl.includes('winner_test') || dl === 'ship') {
      decision = 'ship';
    } else if (dl.includes('kill') || dl.includes('winner_control') || dl === 'kill') {
      decision = 'kill';
    } else {
      // continue / unknown → skip
      continue;
    }

    patterns.experiments_total += 1;

    const base = {
      experiment: name,
      decision,
      date: today(),
      target_kpi: kpi,
      hypothesis_type: hypothesisType,
      hypothesis: '',
      actual_lift: decision === 'ship' ? (test !== 'N/A' ? test : 'unknown') : '측정 불능',
      insight: learning,
      code_pattern: '',
    };

    if (decision === 'ship') {
      patterns.success_patterns.push({ ...base, what_worked: learning });
    } else {
      patterns.failure_patterns.push({ ...base, what_failed: learning });
    }
  }

  savePatterns(patternsPath, patterns);
}

/**
 * Return a summary string of patterns counts.
 *
 * @param {string} patternsPath
 * @returns {string}
 */
export function summarize(patternsPath = DEFAULT_PATTERNS_PATH) {
  const patterns = loadPatterns(patternsPath);
  if (!patterns) return 'No patterns found.';

  const total = patterns.experiments_total || 0;
  const success = (patterns.success_patterns || []).length;
  const failure = (patterns.failure_patterns || []).length;
  const meta = (patterns.meta_learnings || []).length;

  return `${total} experiments: ${success} success, ${failure} failure, ${meta} meta-learnings`;
}

// ─── CLI dispatcher ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const patternsPath = DEFAULT_PATTERNS_PATH;

  if (args.includes('--ingest') && args.includes('--seed')) {
    // Bootstrap from FUNNEL_STATUS.md
    if (!fs.existsSync(FUNNEL_STATUS_PATH)) {
      console.error('[feedback-loop] FUNNEL_STATUS.md not found at', FUNNEL_STATUS_PATH);
      process.exit(1);
    }
    const statusContent = fs.readFileSync(FUNNEL_STATUS_PATH, 'utf-8');
    const stateHistory = loadState().history || [];
    seedFromHistory(statusContent, stateHistory, patternsPath);
    console.log('[feedback-loop] Seeded patterns from FUNNEL_STATUS.md');
    const result = summarize(patternsPath);
    console.log(result);

  } else if (args.includes('--ingest')) {
    // Ingest from evaluation-result.json + experiment-plan.json
    const evalPath = path.resolve(STATE_DIR, 'evaluation-result.json');
    const planPath = path.resolve(STATE_DIR, 'experiment-plan.json');

    if (!fs.existsSync(evalPath)) {
      console.error('[feedback-loop] evaluation-result.json not found');
      process.exit(1);
    }
    if (!fs.existsSync(planPath)) {
      console.error('[feedback-loop] experiment-plan.json not found');
      process.exit(1);
    }

    let evalResult, plan;
    try {
      evalResult = JSON.parse(fs.readFileSync(evalPath, 'utf-8'));
      plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
    } catch (err) {
      console.error('[feedback-loop] Failed to parse input files:', err.message);
      process.exit(1);
    }

    ingestPattern(evalResult, plan, patternsPath);
    console.log('[feedback-loop] Ingested pattern:', evalResult.action);
    console.log(summarize(patternsPath));

  } else if (args.includes('--format') && args.includes('prompt')) {
    const output = formatPrompt(patternsPath);
    if (output) process.stdout.write(output + '\n');

  } else if (args.includes('--summary')) {
    console.log(summarize(patternsPath));

  } else {
    console.error('Usage: feedback-loop.mjs [--ingest [--seed] | --format prompt | --summary]');
    process.exit(1);
  }
}
