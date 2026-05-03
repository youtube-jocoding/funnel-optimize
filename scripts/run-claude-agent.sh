#!/usr/bin/env bash

# ─── Claude Code Agent Runner ────────────────────────────────────────────────
# Runs Claude Code CLI to generate a funnel optimization proposal.
# Output: .funnel-state/proposals/claude/{analysis-report.md, discovery.md, experiment-plan.json}

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PROMPT_TEXT=$(cat <<'PROMPT'
You are running Phase 2-4 of the funnel optimization pipeline as one of two competing agents.
Your goal: produce the best possible experiment plan for the user's project.

## Your Input
Read these files:
1. .funnel-state/latest-snapshot.json (PostHog data)
2. .funnel-state/evaluation-result.json (previous experiment result)
3. .funnel-state/state.json (experiment history)
4. funnel-config.json (KPI targets and guardrails)
5. .claude/skills/funnel-optimize/SKILL.md (Phase 2-4 methodology)
6. The files listed in funnel-config.json's guardrails.allowed_files (current code — find exact old_code strings here)

## PM Skills — Use these for structured analysis:
- /analyze-cohorts for cohort-level conversion analysis
- /north-star for North Star Metric validation
- /discover for full Discovery cycle
- /brainstorm for 3-perspectives ideation

## Output — You MUST produce exactly these 3 files:

### 1. .funnel-state/proposals/claude/analysis-report.md
Korean. Include: KPI dashboard, cohort insights, funnel bottleneck, North Star check.

### 2. .funnel-state/proposals/claude/discovery.md
Korean. Include: Opportunity Solution Tree, assumption Impact×Risk matrix, top 3 ideas.

### 3. .funnel-state/proposals/claude/experiment-plan.json
Must match the experiment-plan.json schema in SKILL.md exactly.
Required: action, hypothesis, opportunity, assumption_category, assumption_risk,
target_kpi, flag_key, experiment_name, description, variant_description,
code_changes[], success_metric, estimated_duration_days, discovery_context.

## CRITICAL RULES:
- old_code must be EXACT from the allowed files, appearing exactly ONCE
- new_code must be valid TypeScript/JSX using useExperiment() hook
- Max 5 code_changes (config.guardrails.max_code_changes); Only files listed in config.guardrails.allowed_files
- NO dark patterns, NO security violations
- Do NOT modify files outside .funnel-state/proposals/claude/
- Do NOT run implement-experiment.mjs or any scripts
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

claude -p "$PROMPT_TEXT" --allowedTools "Read,Write,Glob,Grep" --permission-mode bypassPermissions
