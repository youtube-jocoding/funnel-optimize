#!/usr/bin/env bash

# ─── Multi-Agent Funnel Optimization Orchestrator ─────────────────────────────
#
# Runs Claude Code, Codex CLI, and Gemini CLI in parallel to generate competing
# experiment proposals, then scores and selects the best one.
#
# Usage:
#   bash scripts/orchestrate-triple-agent.sh
#   bash scripts/orchestrate-triple-agent.sh --days 7
#   bash scripts/orchestrate-triple-agent.sh --claude-only
#   bash scripts/orchestrate-triple-agent.sh --codex-only
#   bash scripts/orchestrate-triple-agent.sh --gemini-only

set -euo pipefail

# ─── CLI 가용성 체크 ─────────────────────────────────────────────────────
HAS_CLAUDE="no"; HAS_CODEX="no"; HAS_GEMINI="no"
command -v claude > /dev/null 2>&1 && HAS_CLAUDE="yes"
command -v codex > /dev/null 2>&1 && HAS_CODEX="yes"
command -v gemini > /dev/null 2>&1 && HAS_GEMINI="yes"

if [ "$HAS_CLAUDE" = "no" ]; then
  echo "ERROR: claude CLI is required."
  echo "  Install: https://docs.claude.com/en/docs/claude-code/installation"
  exit 1
fi

ACTIVE_AGENTS="claude"
if [ "$HAS_CODEX" = "yes" ]; then
  ACTIVE_AGENTS="${ACTIVE_AGENTS},codex"
else
  echo "[INFO] codex CLI not found — skipping Codex agent (optional)"
fi
if [ "$HAS_GEMINI" = "yes" ]; then
  ACTIVE_AGENTS="${ACTIVE_AGENTS},gemini"
else
  echo "[INFO] gemini CLI not found — skipping Gemini agent (optional)"
fi
echo "[INFO] Running with agents: ${ACTIVE_AGENTS}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

DAYS=7
MODE="triple"  # triple | claude-only | codex-only | gemini-only

# Parse arguments
for arg in "$@"; do
  case $arg in
    --days=*) DAYS="${arg#*=}" ;;
    --days) shift; DAYS="${1:-7}" ;;
    --claude-only) MODE="claude-only" ;;
    --codex-only) MODE="codex-only" ;;
    --gemini-only) MODE="gemini-only" ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Multi-Agent Funnel Optimization Pipeline               ║"
echo "║  Mode: $MODE | Analysis Period: ${DAYS} days"
echo "║  Agents: Claude Code + Codex CLI + Gemini CLI           ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Phase 1: Shared Data Collection ─────────────────────────────────────────

echo "━━━ Phase 1: Data Collection ━━━"
echo ""

echo "[1/2] Collecting PostHog data..."
node scripts/funnel-automation/collect-data.mjs --days "$DAYS"

echo ""
echo "[2/2] Evaluating previous experiment..."
node scripts/funnel-automation/evaluate-experiment.mjs

# Check if we should skip proposal generation
EVAL_ACTION=$(node -e "
  const fs = require('fs');
  const p = '.funnel-state/evaluation-result.json';
  if (fs.existsSync(p)) {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    console.log(d.action || d.decision?.action || 'none');
  } else {
    console.log('none');
  }
")

if [ "$EVAL_ACTION" = "continue" ]; then
  echo ""
  echo "⏸  Active experiment still running. Skipping new proposal generation."
  echo "   Run archive only."
  node scripts/funnel-automation/archive.mjs
  echo "Done."
  exit 0
fi

# ─── Phase 2-4: Parallel Agent Execution ─────────────────────────────────────

echo ""
echo "━━━ Phase 2-4: Agent Proposals (3 agents) ━━━"
echo ""

# Clean previous proposals
rm -rf .funnel-state/proposals/claude .funnel-state/proposals/codex .funnel-state/proposals/gemini
mkdir -p .funnel-state/proposals/claude .funnel-state/proposals/codex .funnel-state/proposals/gemini

TIMEOUT=1800  # 30 minutes per agent

run_agent() {
  local AGENT_NAME=$1
  local AGENT_LABEL=$2
  local AGENT_SCRIPT=$3

  echo "[${AGENT_LABEL}] Starting..."
  local START_TIME=$(date +%s)

  timeout "$TIMEOUT" bash "$AGENT_SCRIPT" 2>&1 | \
    sed "s/^/  [${AGENT_NAME}] /" || true

  local END_TIME=$(date +%s)
  local DURATION=$((END_TIME - START_TIME))

  # Write metadata
  node -e "
    const fs = require('fs');
    const dir = '.funnel-state/proposals/${AGENT_NAME}';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/metadata.json', JSON.stringify({
      agent: '${AGENT_NAME}',
      duration_seconds: ${DURATION},
      completed_at: new Date().toISOString(),
      artifacts: {
        plan_exists: fs.existsSync(dir + '/experiment-plan.json'),
        analysis_exists: fs.existsSync(dir + '/analysis-report.md'),
        discovery_exists: fs.existsSync(dir + '/discovery.md'),
      },
    }, null, 2));
  "
  echo "[${AGENT_LABEL}] Done (${DURATION}s)"
}

case "$MODE" in
  triple)
    run_agent "claude" "Claude Code" "$ROOT_DIR/scripts/funnel-automation/run-claude-agent.sh" &
    PID_CLAUDE=$!
    if [ "$HAS_CODEX" = "yes" ]; then
      run_agent "codex" "Codex CLI" "$ROOT_DIR/scripts/funnel-automation/run-codex-agent.sh" &
      PID_CODEX=$!
    fi
    if [ "$HAS_GEMINI" = "yes" ]; then
      run_agent "gemini" "Gemini CLI" "$ROOT_DIR/scripts/funnel-automation/run-gemini-agent.sh" &
      PID_GEMINI=$!
    fi
    wait $PID_CLAUDE || true
    [ "$HAS_CODEX" = "yes" ] && wait $PID_CODEX || true
    [ "$HAS_GEMINI" = "yes" ] && wait $PID_GEMINI || true
    ;;
  claude-only)
    run_agent "claude" "Claude Code" "$ROOT_DIR/scripts/funnel-automation/run-claude-agent.sh"
    ;;
  codex-only)
    if [ "$HAS_CODEX" = "yes" ]; then
      run_agent "codex" "Codex CLI" "$ROOT_DIR/scripts/funnel-automation/run-codex-agent.sh"
    else
      echo "ERROR: --codex-only requested but codex CLI not found." && exit 1
    fi
    ;;
  gemini-only)
    if [ "$HAS_GEMINI" = "yes" ]; then
      run_agent "gemini" "Gemini CLI" "$ROOT_DIR/scripts/funnel-automation/run-gemini-agent.sh"
    else
      echo "ERROR: --gemini-only requested but gemini CLI not found." && exit 1
    fi
    ;;
esac

# ─── Phase 4.5a: Automated Scoring (Layer 1) ─────────────────────────────────

echo ""
echo "━━━ Phase 4.5a: Automated Scoring (Layer 1) ━━━"
echo ""

node scripts/funnel-automation/compare-proposals.mjs

# ─── Phase 4.5b: AI Qualitative Synthesis (Layer 2) ──────────────────────────

echo ""
echo "━━━ Phase 4.5b: AI Qualitative Synthesis (Layer 2) ━━━"
echo ""

timeout "$TIMEOUT" bash scripts/funnel-automation/synthesize-winner.sh || {
  echo "⚠  AI synthesis timed out or failed. Falling back to Layer 1 preselection."
  # Fallback: use Layer 1 preselection as winner
  node -e "
    const fs = require('fs');
    const p = '.funnel-state/proposals/comparison-result.json';
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      d.winner = d.preselection?.agent || null;
      d.reason = 'Layer 2 timeout — fallback to Layer 1 preselection: ' + (d.preselection?.reason || '');
      d.needs_human_review = true;
      fs.writeFileSync(p, JSON.stringify(d, null, 2));
      // Copy winning plan
      if (d.winner) {
        const planPath = '.funnel-state/proposals/' + d.winner + '/experiment-plan.json';
        if (fs.existsSync(planPath)) {
          fs.copyFileSync(planPath, '.funnel-state/experiment-plan.json');
        }
      }
    }
  "
}

# Check comparison result
WINNER=$(node -e "
  const fs = require('fs');
  const p = '.funnel-state/proposals/comparison-result.json';
  if (fs.existsSync(p)) {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    console.log(d.winner || 'none');
  } else {
    console.log('none');
  }
")

NEEDS_REVIEW=$(node -e "
  const fs = require('fs');
  const p = '.funnel-state/proposals/comparison-result.json';
  if (fs.existsSync(p)) {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    console.log(d.needs_human_review ? 'true' : 'false');
  } else {
    console.log('true');
  }
")

# ─── Phase 5: Implement (if auto-selected) ───────────────────────────────────

PLAN_ACTION=$(node -e "
  const fs = require('fs');
  const p = '.funnel-state/experiment-plan.json';
  if (fs.existsSync(p)) {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    console.log(d.action || 'none');
  } else {
    console.log('none');
  }
")

if [ "$PLAN_ACTION" = "implement" ]; then
  echo ""
  echo "━━━ Phase 5: Implement Experiment ━━━"
  echo ""
  echo "Winner: $WINNER"

  if [ "$NEEDS_REVIEW" = "true" ]; then
    echo ""
    echo "⚠  Close scores — flagged for human review."
    echo "   Review proposals in .funnel-state/proposals/{claude,codex,gemini}/"
    echo "   The winning plan is in .funnel-state/experiment-plan.json"
    echo ""
    echo "   To proceed: node scripts/funnel-automation/implement-experiment.mjs"
  else
    echo "Implementing ${WINNER}'s experiment plan..."
    node scripts/funnel-automation/implement-experiment.mjs
  fi
elif [ "$PLAN_ACTION" = "needs_review" ]; then
  echo ""
  echo "⚠  No auto-selection possible. Review all proposals manually."
  echo "   .funnel-state/proposals/{claude,codex,gemini}/"
else
  echo ""
  echo "ℹ  Plan action: $PLAN_ACTION — skipping implementation."
fi

# ─── Phase 7: Archive ────────────────────────────────────────────────────────

echo ""
echo "━━━ Phase 7: Archive ━━━"
echo ""

node scripts/funnel-automation/archive.mjs

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Pipeline Complete                                          ║"
echo "╠══════════════════════════════════════════════════════════════╣"

if [ -f ".funnel-state/proposals/comparison-result.json" ]; then
  node -e "
    const fs = require('fs');
    const r = JSON.parse(fs.readFileSync('.funnel-state/proposals/comparison-result.json', 'utf-8'));
    const agents = Object.keys(r.proposals || {});
    for (const a of agents) {
      const p = r.proposals[a];
      const mark = a === r.winner ? '★' : ' ';
      console.log('║  ' + mark + ' ' + a.padEnd(8) + ': ' + String(p.score || 0).padStart(3) + '/100  ' + (p.target_kpi || '-').padEnd(22) + '║');
    }
    console.log('║                                                            ║');
    console.log('║  Winner: ' + (r.winner || 'NONE').padEnd(48) + '║');
    if (r.needs_human_review) {
      console.log('║  ⚠ Flagged for human review                                ║');
    }
  "
fi

echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
