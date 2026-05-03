#!/usr/bin/env bash

# ─── AI Qualitative Synthesis (Layer 2) ──────────────────────────────────────
#
# After automated scoring (Layer 1), this script asks Claude Code to perform
# a PM-level qualitative evaluation of all proposals and make the final decision.
#
# Claude Code reads:
#   - All 3 agents' analysis reports, discovery docs, and experiment plans
#   - The automated comparison-result.json (Layer 1 scores + convergence)
#   - Current experiment state and funnel data
#
# Claude Code decides the winner based on strategic quality, not just form.
#
# Output:
#   - Updates .funnel-state/proposals/comparison-result.json (winner, reason, ai_synthesis)
#   - Copies winning plan to .funnel-state/experiment-plan.json

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[Synthesis] Starting AI qualitative evaluation (Layer 2)..."

claude -p "$(cat <<'PROMPT'
You are the PM Lead making the FINAL decision on which experiment to run.
Layer 1 (automated scoring) already checked structural validity. Your job is
STRATEGIC QUALITY — the things machines can't score.

## Read these files now:

### Layer 1 results
- .funnel-state/proposals/comparison-result.json (automated scores, convergence analysis)

### Agent proposals (read ALL of them)
- .funnel-state/proposals/claude/analysis-report.md
- .funnel-state/proposals/claude/discovery.md
- .funnel-state/proposals/claude/experiment-plan.json
- .funnel-state/proposals/codex/analysis-report.md
- .funnel-state/proposals/codex/discovery.md
- .funnel-state/proposals/codex/experiment-plan.json
- .funnel-state/proposals/gemini/analysis-report.md
- .funnel-state/proposals/gemini/discovery.md
- .funnel-state/proposals/gemini/experiment-plan.json

### Context
- .funnel-state/latest-snapshot.json (current data)
- .funnel-state/state.json (active experiment, history)
- funnel-config.json (KPI targets)

## Your Evaluation Framework (PM-Skills based)

Score each proposal 1-5 on these dimensions. Be harsh — differentiate clearly.

### 1. Discovery Quality (OST, Assumption Mapping)
- Does the OST have ≥3 opportunities with ≥2 solutions each?
- Are assumptions categorized (Value/Usability/Viability/Feasibility)?
- Is there a visual Impact×Risk matrix?
- Is the "Test First" choice well-justified?

### 2. Data-Driven Insight Quality
- Are specific numbers cited from the snapshot (not vague claims)?
- Are device/language/referrer cohorts analyzed with cross-tabulation?
- Did the agent discover non-obvious insights?
- Are calculations shown (not just stated)?

### 3. XYZ Hypothesis Rigor
- Does it follow "We believe [X] will improve [Y] by [Z] because [evidence]"?
- Is [Z] quantified with a realistic target?
- Is [evidence] data-backed (not just assumed)?

### 4. Strategic Alignment
- Does targeting this KPI make sense given the active experiment?
- Does it enable parallel learning (different KPI than active exp)?
- Does it contribute to a Growth Loop (viral/referral) vs one-time?
- Does it connect to the North Star Metric?

### 5. Experiment Safety & Coexistence
- Does it preserve the active experiment (no flag replacement)?
- Is the code change minimal and easily reversible?
- Does it support all major languages (ko, en, ja minimum)?
- Is there a clean control/test separation?

### 6. Unique Insight (Bonus)
- Did this agent discover something the others missed?
- Is the approach genuinely different (not just cosmetic variation)?

## Output

Write EXACTLY this JSON to: .funnel-state/proposals/comparison-result.json

Read the existing file first (it has Layer 1 data). Update only these fields:
- "winner": the winning agent name
- "reason": 1-2 sentence explanation
- "needs_human_review": true/false
- "ai_synthesis": an object with your full evaluation

The ai_synthesis object must have this structure:
{
  "evaluated_at": "ISO date",
  "evaluator": "claude-code-pm-synthesis",
  "agent_scores": {
    "claude": { "discovery": 1-5, "data_insight": 1-5, "hypothesis": 1-5, "strategic_alignment": 1-5, "safety": 1-5, "unique_insight": 0-2, "total": sum, "strengths": ["..."], "weaknesses": ["..."] },
    "codex": { same structure },
    "gemini": { same structure }
  },
  "convergence_assessment": "what does agent convergence/divergence tell us?",
  "strategic_rationale": "why the winner is the best choice RIGHT NOW",
  "best_ideas_from_losers": ["ideas worth preserving from non-winners"],
  "next_experiment_suggestion": "what to test after this one, informed by losing proposals"
}

Also copy the winning agent's experiment-plan.json to .funnel-state/experiment-plan.json

If you think the best plan is a HYBRID combining elements from multiple agents,
create a new merged experiment-plan.json and set winner to "synthesis".

## Rules
- DO NOT just pick the highest automated score — that's Layer 1's job
- Focus on STRATEGIC quality and PM judgment
- Be specific in your reasoning — cite exact data points
- If all proposals are poor, set winner to null and needs_human_review to true
PROMPT
)" --permission-mode bypassPermissions --allowedTools "Read,Write,Glob,Grep" 2>&1 | tail -20

echo "[Synthesis] Layer 2 complete."
