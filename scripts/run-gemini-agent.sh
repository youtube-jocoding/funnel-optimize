#!/usr/bin/env bash

# ─── Gemini CLI Agent Runner ─────────────────────────────────────────────────
# Runs Gemini CLI to generate a funnel optimization proposal.
# Output: .funnel-state/proposals/gemini/{analysis-report.md, discovery.md, experiment-plan.json}

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PROMPT_TEXT=$(cat <<'PROMPT'
You are running Phase 2-4 of the funnel optimization pipeline as one of three competing agents.
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
1. Calculate conversion rates at each funnel step from the snapshot
2. Compare device cohorts (mobile vs desktop)
3. Compare language cohorts
4. Identify biggest drop-off with exact numbers
5. Build Opportunity Solution Tree: Outcome → Opportunities → Solutions
6. Map assumptions: Value, Usability, Viability, Feasibility, Ethics
7. Score Impact(1-5) × Risk(1-5), select highest
8. Write XYZ hypothesis: "We believe [X change] will improve [Y metric] by [Z amount] because [evidence]"

## Output — Create exactly these 3 files:

### 1. .funnel-state/proposals/gemini/analysis-report.md
Write in Korean. Include:
- KPI dashboard table with current values, targets, and gaps
- Funnel conversion rates at each step with exact numbers
- Device/language/referrer cohort insights
- Funnel bottleneck identification

### 2. .funnel-state/proposals/gemini/discovery.md
Write in Korean. Include:
- Opportunity Solution Tree (text diagram)
- Assumption mapping table with Impact×Risk scoring
- Top 3 experiment ideas with rationale for each

### 3. .funnel-state/proposals/gemini/experiment-plan.json
EXACT JSON schema (must be valid parseable JSON):
{
  "action": "implement",
  "hypothesis": "XYZ hypothesis string",
  "opportunity": "from OST",
  "assumption_category": "Value|Usability|Viability|Feasibility|Ethics",
  "assumption_risk": "High|Medium|Low",
  "target_kpi": "<one of the kpi values from funnel-config.json optimization_targets[].kpi>",
  "flag_key": "funnel-exp-YYYYMMDD-short-name",
  "experiment_name": "descriptive name",
  "description": "what the experiment does",
  "variant_description": { "control": "current version", "test": "test version" },
  "code_changes": [
    {
      "file": "<file from config.guardrails.allowed_files>",
      "description": "what changes",
      "old_code": "EXACT string from current file that appears exactly ONCE",
      "new_code": "valid replacement TSX code"
    }
  ],
  "success_metric": {
    "event_numerator": ["click_event_name"],
    "event_denominator": "impression_event_name",
    "target_lift": 30
  },
  "estimated_duration_days": 7,
  "discovery_context": {
    "ost_opportunity": "opportunity from your OST",
    "brainstorm_perspective": "PM|Designer|Engineer",
    "cohort_insight": "key data insight"
  }
}

## How to use useExperiment() hook:
import { useExperiment } from '../lib/experiment';
const variant = useExperiment('funnel-exp-YYYYMMDD-name');
{variant === 'test' ? <TestVersion /> : <ControlVersion />}

## CRITICAL RULES:
- old_code must be an EXACT verbatim substring from the file, appearing ONCE
- new_code must be syntactically valid TypeScript/JSX
- Max 5 code_changes
- Only allowed files: those listed in funnel-config.json guardrails.allowed_files
- NO dark patterns: no fake urgency, countdown timers, fake social proof, deceptive buttons
- NO security issues: no eval(), innerHTML, dangerouslySetInnerHTML, external fetch
- Do NOT modify files outside .funnel-state/proposals/gemini/
- Do NOT run any scripts
- For text changes, use translation keys from t object or activeLang ternary covering ko, ja, en at minimum
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

gemini -p "$PROMPT_TEXT" --yolo
