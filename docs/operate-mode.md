# Operate Mode (weekly workflow)

The 7-phase pipeline that runs weekly to evaluate experiments, diagnose funnel issues, design new experiments, and ship code.

## Trigger

In Claude Code: `/funnel-optimize`

Manual command-line equivalent:
```bash
# Phase 1
node scripts/funnel-automation/collect-data.mjs --days 7
node scripts/funnel-automation/evaluate-experiment.mjs

# Phase 2: Claude Code reads snapshot.json and writes diagnosis to FUNNEL_OPTIMIZATION_REPORT.md

# Phase 3 (only if Phase 1 says: none / killed / winner)
bash scripts/funnel-automation/orchestrate-triple-agent.sh

# Phase 4
node scripts/funnel-automation/implement-experiment.mjs

# Phase 7
node scripts/funnel-automation/archive.mjs
```

## Decision tree

```
Phase 1 evaluation result:
├── none (no active experiment)
│   └── → Phase 2 → Phase 3 (design new)
├── continue (running, not significant yet)
│   └── → Phase 2 (diagnostic only) → Phase 7 (archive)
├── winner_test
│   └── → Phase 5 (analyze) → Phase 5-C (cleanup) → Phase 3 (next experiment)
├── winner_control
│   └── → Phase 5 (analyze, kill test) → Phase 5-C → Phase 3
└── killed (manual --kill flag)
    └── → Phase 5-C → Phase 3
```

## Early termination

Experiment terminates early when:
- `min_early_decision_days` met (default: 3)
- `min_sample_size` met (default: 500 impressions)
- p-value < `significance_level` (default: 0.05)

Forced termination at `max_experiment_days` (default: 14).

## Manual Kill

```bash
node scripts/funnel-automation/evaluate-experiment.mjs --kill
```

→ Disables PostHog flag immediately + records `ended_reason: "killed"` in history.

## Critical rules (from animalface 7-week learning)

### 1. Real revenue over vanity
**Never ship based on CTR alone.** CTR is a proxy. The pipeline learned this the hard way: a +521% CTR experiment shipped, then reverted when 0 actual payments occurred.

The Ship gate: `optimization_targets[].priority=P0` must show positive lift, not just CTR.

### 2. Structural changes beat copy changes
3 consecutive copy-only experiments failed. The pipeline now preserves this in `patterns.json` and prompts agents to avoid copy-only proposals.

### 3. Guardrails are non-negotiable
- Dark patterns (fake urgency, fake social proof, deceptive buttons) → automatically rejected
- Files outside `allowed_files` → automatically rejected
- Domains outside `allowed_domains_for_redirects` → automatically rejected
- eval/innerHTML/dangerouslySetInnerHTML → automatically rejected
- Stripe key/price modifications → automatically rejected

## Cumulative Learning

```bash
# After each Kill or Ship
node scripts/funnel-automation/feedback-loop.mjs --ingest
```

This updates `patterns.json` with what worked / what failed. Next week's Triple-Agent prompt automatically includes:
> "Past failures to avoid: <patterns>"
> "Past successes to consider: <patterns>"
