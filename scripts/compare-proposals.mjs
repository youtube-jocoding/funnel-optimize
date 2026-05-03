#!/usr/bin/env node

/**
 * Compare proposals from Claude Code, Codex CLI, and Gemini CLI.
 *
 * Two-layer evaluation:
 *   Layer 1 — Automated scoring (this script): structural validity, safety, schema
 *   Layer 2 — AI qualitative synthesis (synthesize-winner.sh): strategic quality
 *
 * This script handles Layer 1 only. It produces a pre-scored comparison that
 * the AI synthesis step uses as one of many inputs.
 *
 * Usage:
 *   node scripts/funnel-automation/compare-proposals.mjs
 *
 * Reads:  .funnel-state/proposals/{claude,codex,gemini}/
 * Output: .funnel-state/proposals/comparison-result.json
 */

import fs from 'fs';
import path from 'path';
import {
  loadConfig, loadState, scanForSecurityIssues, validateGuardrails, ROOT_DIR, formatDate,
} from './lib.mjs';

const PROPOSALS_DIR = path.resolve(ROOT_DIR, '.funnel-state/proposals');
const AGENTS = ['claude', 'codex', 'gemini'];

// ─── Scoring Rubric (100 points) ────────────────────────────────────────────

function scoreProposal(agentName, config, state) {
  const dir = path.resolve(PROPOSALS_DIR, agentName);
  const result = {
    agent: agentName,
    score: 0,
    breakdown: {
      completeness: 0,       // 15 pts
      schema_validity: 0,    // 15 pts (was 20)
      code_validity: 0,      // 20 pts (was 25)
      guardrail_compliance: 0, // 15 pts
      kpi_alignment: 0,      // 5 pts (was 10)
      novelty: 0,            // 10 pts
      analysis_depth: 0,     // 5 pts
      strategic_safety: 0,   // 15 pts (NEW)
    },
    experiment_name: null,
    target_kpi: null,
    hypothesis: null,
    errors: [],
    warnings: [],
    strategic_flags: [],
    plan: null,
  };

  // ─── 1. Completeness (15 pts) ───────────────────────────────────────────

  const planPath = path.resolve(dir, 'experiment-plan.json');
  const analysisPath = path.resolve(dir, 'analysis-report.md');
  const discoveryPath = path.resolve(dir, 'discovery.md');

  if (fs.existsSync(planPath)) result.breakdown.completeness += 5;
  else result.errors.push('experiment-plan.json missing');

  if (fs.existsSync(analysisPath)) result.breakdown.completeness += 5;
  else result.errors.push('analysis-report.md missing');

  if (fs.existsSync(discoveryPath)) result.breakdown.completeness += 5;
  else result.errors.push('discovery.md missing');

  if (!fs.existsSync(planPath)) {
    result.score = result.breakdown.completeness;
    return result;
  }

  // ─── Load plan ──────────────────────────────────────────────────────────

  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
    result.plan = plan;
    result.experiment_name = plan.experiment_name || null;
    result.target_kpi = plan.target_kpi || null;
    result.hypothesis = plan.hypothesis || null;
  } catch (err) {
    result.errors.push(`Failed to parse experiment-plan.json: ${err.message}`);
    result.score = result.breakdown.completeness;
    return result;
  }

  // ─── 2. Schema Validity (15 pts) ──────────────────────────────────────

  const requiredFields = [
    'action', 'hypothesis', 'target_kpi', 'flag_key', 'experiment_name',
    'description', 'variant_description', 'code_changes', 'success_metric',
  ];
  const optionalBonusFields = [
    'opportunity', 'assumption_category', 'assumption_risk',
    'discovery_context', 'estimated_duration_days',
  ];

  let schemaScore = 0;
  for (const field of requiredFields) {
    if (plan[field] !== undefined && plan[field] !== null) {
      schemaScore += 1.5;
    } else {
      result.errors.push(`Missing required field: ${field}`);
    }
  }

  let bonusCount = 0;
  for (const field of optionalBonusFields) {
    if (plan[field] !== undefined && plan[field] !== null) bonusCount++;
  }
  schemaScore += Math.min(1.5, bonusCount * 0.3);

  result.breakdown.schema_validity = Math.min(15, Math.round(schemaScore));

  if (plan.variant_description && (!plan.variant_description.control || !plan.variant_description.test)) {
    result.errors.push('variant_description missing control or test');
    result.breakdown.schema_validity = Math.max(0, result.breakdown.schema_validity - 2);
  }

  if (plan.code_changes && !Array.isArray(plan.code_changes)) {
    result.errors.push('code_changes is not an array');
    result.breakdown.schema_validity = Math.max(0, result.breakdown.schema_validity - 5);
  }

  // ─── 3. Code Validity (20 pts) ────────────────────────────────────────

  if (Array.isArray(plan.code_changes) && plan.code_changes.length > 0) {
    let validChanges = 0;
    let totalChanges = plan.code_changes.length;

    for (const change of plan.code_changes) {
      if (!change.file || !change.old_code || !change.new_code) {
        result.errors.push(`Incomplete code_change: missing file/old_code/new_code`);
        continue;
      }

      const filePath = path.resolve(ROOT_DIR, change.file);
      if (!fs.existsSync(filePath)) {
        result.errors.push(`File not found: ${change.file}`);
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const occurrences = content.split(change.old_code).length - 1;

      if (occurrences === 0) {
        result.errors.push(`old_code not found in ${change.file}: "${change.old_code.slice(0, 60)}..."`);
        continue;
      }
      if (occurrences > 1) {
        result.errors.push(`old_code appears ${occurrences} times in ${change.file} (must be unique)`);
        continue;
      }

      if (change.new_code.trim().length === 0) {
        result.errors.push(`new_code is empty for ${change.file}`);
        continue;
      }

      validChanges++;
    }

    result.breakdown.code_validity = Math.round((validChanges / totalChanges) * 20);
  } else {
    result.errors.push('No code_changes provided');
    result.breakdown.code_validity = 0;
  }

  // ─── 4. Guardrail Compliance (15 pts) ─────────────────────────────────

  let guardrailScore = 15;

  for (const change of plan.code_changes || []) {
    if (change.new_code) {
      const issues = scanForSecurityIssues(change.new_code);
      if (issues.length > 0) {
        guardrailScore -= 5 * issues.length;
        result.errors.push(...issues.map(i => `Security: ${i}`));
      }
    }
  }

  const violations = validateGuardrails(plan, config);
  if (violations.length > 0) {
    guardrailScore -= 3 * violations.length;
    result.errors.push(...violations.map(v => `Guardrail: ${v}`));
  }

  result.breakdown.guardrail_compliance = Math.max(0, guardrailScore);

  // ─── 5. KPI Alignment (5 pts) ─────────────────────────────────────────

  const kpiPriority = {};
  for (const target of config.optimization_targets) {
    kpiPriority[target.kpi] = target.priority;
  }

  const priority = kpiPriority[plan.target_kpi];
  if (priority === 'P0') result.breakdown.kpi_alignment = 5;
  else if (priority === 'P1') result.breakdown.kpi_alignment = 4;
  else if (priority === 'P2') result.breakdown.kpi_alignment = 2;
  else if (priority === 'P3') result.breakdown.kpi_alignment = 1;
  else {
    result.breakdown.kpi_alignment = 0;
    result.errors.push(`Unknown target_kpi: ${plan.target_kpi}`);
  }

  // ─── 6. Novelty (10 pts) ──────────────────────────────────────────────

  const history = state.history || [];
  const pastNames = history.map(h => (h.experiment_name || '').toLowerCase());
  const pastFlags = history.map(h => (h.flag_key || '').toLowerCase());

  const nameMatch = pastNames.some(n => n === (plan.experiment_name || '').toLowerCase());
  const flagMatch = pastFlags.some(f => f === (plan.flag_key || '').toLowerCase());

  if (!nameMatch && !flagMatch) {
    result.breakdown.novelty = 10;
  } else if (nameMatch || flagMatch) {
    result.breakdown.novelty = 0;
    result.errors.push('Experiment name/flag duplicates a past experiment');
  }

  const recentHypotheses = history.slice(-3).map(h => (h.hypothesis || '').toLowerCase());
  const currentHypothesis = (plan.hypothesis || '').toLowerCase();
  for (const past of recentHypotheses) {
    if (past.length > 20 && currentHypothesis.includes(past.slice(0, 30))) {
      result.breakdown.novelty = Math.max(0, result.breakdown.novelty - 5);
      result.errors.push('Hypothesis too similar to a recent experiment');
      break;
    }
  }

  // ─── 7. Analysis Depth (5 pts) ────────────────────────────────────────

  if (fs.existsSync(analysisPath)) {
    const analysisContent = fs.readFileSync(analysisPath, 'utf-8');
    const wordCount = analysisContent.split(/\s+/).length;
    if (wordCount >= 500) result.breakdown.analysis_depth = 5;
    else if (wordCount >= 300) result.breakdown.analysis_depth = 3;
    else if (wordCount >= 100) result.breakdown.analysis_depth = 1;
  }

  // ─── 8. Strategic Safety (15 pts — NEW) ───────────────────────────────
  //
  // Detects strategic red flags that automated scoring previously missed:
  //  - Active experiment conflict (flag replacement)
  //  - Parallel learning opportunity (vs redundant KPI targeting)
  //  - Rollback safety
  //  - i18n coverage

  let strategicScore = 15;

  // 8a. Active experiment conflict detection (-10 pts, critical)
  const activeExp = state.active_experiment;
  if (activeExp && activeExp.flag_key) {
    for (const change of plan.code_changes || []) {
      // Does this plan REPLACE an existing experiment's useExperiment call?
      if (change.old_code && change.old_code.includes(activeExp.flag_key) &&
          change.new_code && !change.new_code.includes(activeExp.flag_key)) {
        strategicScore -= 10;
        result.strategic_flags.push(
          `CRITICAL: Replaces active experiment flag '${activeExp.flag_key}' — would destroy in-progress experiment data`
        );
        result.errors.push(`Active experiment conflict: replaces ${activeExp.flag_key}`);
      }
    }

    // Does this plan target the same KPI as the active experiment?
    if (activeExp.target_kpi === plan.target_kpi) {
      strategicScore -= 3;
      result.strategic_flags.push(
        `Targets same KPI (${plan.target_kpi}) as active experiment '${activeExp.experiment_name}' — redundant, no parallel learning`
      );
      result.warnings.push(`Same KPI as active experiment: ${plan.target_kpi}`);
    }
  }

  // 8b. Rollback safety (-3 pts)
  // Plans that REPLACE large code blocks are riskier than those that ADD
  const totalOldCodeLength = (plan.code_changes || []).reduce((sum, c) => sum + (c.old_code || '').length, 0);
  const totalNewCodeLength = (plan.code_changes || []).reduce((sum, c) => sum + (c.new_code || '').length, 0);
  const replacementRatio = totalOldCodeLength > 0 ? totalNewCodeLength / totalOldCodeLength : 1;

  if (replacementRatio > 5 && totalOldCodeLength > 200) {
    // Massive expansion of existing code block — harder to rollback
    strategicScore -= 2;
    result.warnings.push(`Large code expansion (${totalOldCodeLength} → ${totalNewCodeLength} chars): harder to rollback`);
  }

  // 8c. i18n coverage check (-2 pts) — only runs if config.project.languages defined
  const projectLanguages = config.project?.languages || [];
  if (projectLanguages.length >= 2) {
    const newCodeAll = (plan.code_changes || []).map(c => c.new_code || '').join('\n');
    const matchedLangs = projectLanguages.filter(lang => {
      const pattern = new RegExp(`activeLang\\s*===?\\s*['"]${lang}['"]|lang.*${lang}|'${lang}'`, 'i');
      return pattern.test(newCodeAll);
    });
    if (newCodeAll.length > 100 && matchedLangs.length < Math.min(2, projectLanguages.length)) {
      strategicScore -= 2;
      result.warnings.push(`Limited i18n coverage: only ${matchedLangs.length}/${projectLanguages.length} languages (${projectLanguages.join('/')})`);
    }
  }

  result.breakdown.strategic_safety = Math.max(0, strategicScore);

  // ─── Total ──────────────────────────────────────────────────────────────

  result.score = Object.values(result.breakdown).reduce((a, b) => a + b, 0);
  return result;
}

// ─── Convergence Analysis ─────────────────────────────────────────────────────
// Detects if multiple agents independently converge on the same conclusion

function analyzeConvergence(scores) {
  const validAgents = AGENTS.filter(a => scores[a].score > 0 && scores[a].target_kpi);

  // Group by target KPI
  const byKpi = {};
  for (const agent of validAgents) {
    const kpi = scores[agent].target_kpi;
    if (!byKpi[kpi]) byKpi[kpi] = [];
    byKpi[kpi].push(agent);
  }

  const convergence = {
    converged_kpi: null,
    converged_agents: [],
    divergent_agents: [],
    convergence_strength: 'none', // none | weak | strong
    signal: '',
  };

  for (const [kpi, agents] of Object.entries(byKpi)) {
    if (agents.length >= 2) {
      convergence.converged_kpi = kpi;
      convergence.converged_agents = agents;
      convergence.divergent_agents = validAgents.filter(a => !agents.includes(a));
      convergence.convergence_strength = agents.length >= 3 ? 'strong' : 'weak';
      convergence.signal = agents.length >= 3
        ? `All ${agents.length} agents independently target ${kpi} — very high confidence`
        : `${agents.length}/${validAgents.length} agents converge on ${kpi} — good confidence`;
      break;
    }
  }

  if (!convergence.converged_kpi && validAgents.length > 1) {
    convergence.signal = 'All agents target different KPIs — diverse perspectives, no convergence signal';
  }

  return convergence;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Funnel Automation: Compare Proposals (Layer 1 — Automated) ===\n');

  const config = loadConfig();
  const state = loadState();

  // Score each agent's proposal
  const scores = {};
  for (const agent of AGENTS) {
    const agentDir = path.resolve(PROPOSALS_DIR, agent);
    if (!fs.existsSync(agentDir)) {
      console.log(`  ${agent}: No proposal directory found. Skipping.`);
      scores[agent] = {
        agent, score: 0, breakdown: {}, errors: ['No proposal submitted'],
        warnings: [], strategic_flags: [],
        experiment_name: null, target_kpi: null, hypothesis: null, plan: null,
      };
      continue;
    }

    scores[agent] = scoreProposal(agent, config, state);
    console.log(`  ${agent}: ${scores[agent].score}/100`);

    if (scores[agent].strategic_flags.length > 0) {
      console.log(`    Strategic flags:`);
      scores[agent].strategic_flags.forEach(f => console.log(`      ⚠ ${f}`));
    }
    if (scores[agent].errors.length > 0) {
      console.log(`    Errors (${scores[agent].errors.length}):`);
      scores[agent].errors.slice(0, 5).forEach(e => console.log(`      - ${e}`));
      if (scores[agent].errors.length > 5) {
        console.log(`      ... and ${scores[agent].errors.length - 5} more`);
      }
    }
    if (scores[agent].warnings.length > 0) {
      scores[agent].warnings.forEach(w => console.log(`    ⚡ ${w}`));
    }
  }

  // ─── Convergence Analysis ─────────────────────────────────────────────

  const convergence = analyzeConvergence(scores);
  if (convergence.converged_kpi) {
    console.log(`\n  Convergence: ${convergence.signal}`);
  }

  // ─── Automated Pre-selection (soft recommendation) ────────────────────
  // This is NOT the final winner — just a pre-selection for the AI synthesis

  const sortedAgents = AGENTS
    .filter(a => scores[a].score > 0)
    .sort((a, b) => scores[b].score - scores[a].score);

  let preselection = null;
  let preselectionReason = '';

  if (sortedAgents.length === 0) {
    preselectionReason = 'All agents failed';
  } else {
    // Disqualify agents with critical strategic flags
    const qualified = sortedAgents.filter(a =>
      !scores[a].strategic_flags.some(f => f.startsWith('CRITICAL:'))
    );

    if (qualified.length === 0) {
      preselectionReason = 'All agents have critical strategic issues';
    } else {
      preselection = qualified[0];
      preselectionReason = `Highest score among qualified: ${scores[preselection].score}/100`;

      if (convergence.converged_agents.includes(preselection)) {
        preselectionReason += ` (aligned with convergence on ${convergence.converged_kpi})`;
      }
    }
  }

  console.log(`\n  Pre-selection: ${preselection || 'NONE'}`);
  console.log(`  Reason: ${preselectionReason}`);
  console.log(`\n  → Final decision will be made by AI qualitative synthesis (Layer 2)`);

  // ─── Save comparison result ───────────────────────────────────────────

  const cleanScores = {};
  for (const agent of AGENTS) {
    const { plan, ...rest } = scores[agent];
    cleanScores[agent] = rest;
  }

  const comparisonResult = {
    compared_at: new Date().toISOString(),
    evaluation_layer: 'automated_scoring',
    proposals: cleanScores,
    convergence,
    preselection: {
      agent: preselection,
      reason: preselectionReason,
    },
    // These fields will be filled by synthesize-winner.sh (Layer 2)
    winner: null,
    reason: null,
    needs_human_review: true,
    ai_synthesis: null,
  };

  if (!fs.existsSync(PROPOSALS_DIR)) fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  const comparisonPath = path.resolve(PROPOSALS_DIR, 'comparison-result.json');
  fs.writeFileSync(comparisonPath, JSON.stringify(comparisonResult, null, 2));

  console.log('\nLayer 1 complete. Run synthesize-winner.sh for Layer 2.');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
