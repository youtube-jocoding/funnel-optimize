#!/usr/bin/env bash

# ─── Codex CLI Agent Runner ──────────────────────────────────────────────────
# Runs Codex CLI to generate a funnel optimization proposal.
# Output: .funnel-state/proposals/codex/{analysis-report.md, discovery.md, experiment-plan.json}

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PROMPT_TEXT=$(cat <<'PROMPT'
You are running Phase 2-4 of the funnel optimization pipeline as one of two competing agents.
Your goal: produce the best possible experiment plan for the user's project (framework defined in funnel-config.json's project.framework).

## Context
Project context, KPIs, and guardrails are defined in funnel-config.json — read it FIRST.

## Input — Read these files first:
1. .funnel-state/latest-snapshot.json — PostHog data (KPIs, funnels, cohorts)
2. .funnel-state/evaluation-result.json — previous experiment result
3. .funnel-state/state.json — experiment history
4. funnel-config.json — KPI targets and guardrails
5. Files listed in funnel-config.json guardrails.allowed_files (find EXACT old_code there)

## Analysis Framework:
1. Calculate conversion rates at each funnel step
2. Compare device cohorts (mobile vs desktop)
3. Compare language cohorts
4. Identify biggest drop-off with exact numbers
5. Build Opportunity Solution Tree: Outcome → Opportunities → Solutions
6. Map assumptions: Value, Usability, Viability, Feasibility, Ethics
7. Score Impact(1-5) × Risk(1-5), select highest
8. Write XYZ hypothesis

## Output — Create exactly these 3 files:

### 1. .funnel-state/proposals/codex/analysis-report.md
Korean. Include: KPI dashboard, cohort insights, funnel bottleneck analysis.

### 2. .funnel-state/proposals/codex/discovery.md
Korean. Include: OST, assumption mapping with Impact×Risk, top 3 experiment ideas.

### 3. .funnel-state/proposals/codex/experiment-plan.json
JSON schema:
{
  "action": "implement",
  "hypothesis": "XYZ hypothesis",
  "opportunity": "from OST",
  "assumption_category": "Value|Usability|Viability|Feasibility|Ethics",
  "assumption_risk": "High|Medium|Low",
  "target_kpi": "<one of the kpi values from funnel-config.json optimization_targets[].kpi>",
  "flag_key": "funnel-exp-YYYYMMDD-short-name",
  "experiment_name": "name",
  "description": "description",
  "variant_description": { "control": "...", "test": "..." },
  "code_changes": [
    {
      "file": "<file from config.guardrails.allowed_files>",
      "description": "what changes",
      "old_code": "EXACT string from file, appears ONCE",
      "new_code": "valid TSX using useExperiment() hook"
    }
  ],
  "success_metric": {
    "event_numerator": ["click_event"],
    "event_denominator": "impression_event",
    "target_lift": 30
  },
  "estimated_duration_days": 7,
  "discovery_context": {
    "ost_opportunity": "...",
    "brainstorm_perspective": "PM|Designer|Engineer",
    "cohort_insight": "key insight"
  }
}

## useExperiment() hook usage:
import { useExperiment } from '../lib/experiment';
const variant = useExperiment('funnel-exp-YYYYMMDD-name');
{variant === 'test' ? <TestVersion /> : <ControlVersion />}

## RULES:
- old_code: exact substring, appears once in file
- new_code: valid TSX, no eval/innerHTML/dangerouslySetInnerHTML
- Max 5 code_changes
- Only files in config.guardrails.allowed_files
- NO dark patterns (fake urgency, fake social proof, deceptive buttons)
- Do NOT modify files outside .funnel-state/proposals/codex/
PROMPT
)

# Inject past experiment learnings if available
FEEDBACK=""
if [ -f "$ROOT_DIR/.funnel-state/patterns.json" ]; then
  FEEDBACK=$(node "$ROOT_DIR/scripts/funnel-automation/feedback-loop.mjs" --format prompt 2>/dev/null || true)
fi
if [ -n "$FEEDBACK" ]; then
  PROMPT_TEXT="${PROMPT_TEXT}

${FEEDBACK}
"
fi

codex exec --full-auto "$PROMPT_TEXT"
