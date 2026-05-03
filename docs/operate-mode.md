# Operate Mode

The 7-phase pipeline that evaluates the active experiment, diagnoses funnel issues, designs new experiments, and ships code.

## Cadence

There is no fixed cadence. Run `/funnel-optimize` whenever you want to advance the loop. The pipeline detects state and acts accordingly:

- **Still collecting** (`continue`) → diagnostic update only, no new experiment.
- **Significance reached** (`winner_test` / `winner_control`) → finalize, clean up code, and design the next experiment.
- **Killed** (manual or guardrail) → cleanup → next experiment.

The collection window is determined by `automation.experiment_window_days` in `funnel-config.json` (computed from your DAU during Discovery). Significance can fire **earlier** than the window — as soon as `min_sample_size + p<significance_level` is met, the winner applies.

## Trigger

In Claude Code: `/funnel-optimize`

Manual command-line equivalent:

```bash
# Phase 1
node scripts/funnel-automation/collect-data.mjs            # uses experiment_window_days from config
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

## Significance-driven termination

Experiment terminates as soon as **all** of these hold:

- `min_sample_size` reached (default `500`)
- `p < significance_level` (default `0.05`)
- (Optional) `min_early_decision_days` floor met (default `0` — no floor)

Forced termination at `max_experiment_days` (default: `28`).

To require a calendar floor (e.g. for novelty/day-of-week effects on slow-moving products), set `automation.min_early_decision_days` to a positive value.

## Manual Kill

```bash
node scripts/funnel-automation/evaluate-experiment.mjs --kill
```

→ Disables PostHog flag immediately + records `ended_reason: "killed"` in history.

## Critical rules

### 1. Real revenue over vanity
**Never ship based on CTR alone.** CTR is a proxy. Ship by `optimization_targets[].priority=P0` (typically a real revenue event), not by click-through rates.

### 2. Structural changes beat copy changes
Repeated CTA-copy-only experiments tend to plateau. Once the pattern history records consecutive copy-only failures, agents are prompted to propose layout/timing/surface changes instead.

### 3. Guardrails are non-negotiable
- Dark patterns (fake urgency, fake social proof, deceptive buttons) → automatically rejected
- Files outside `allowed_files` → automatically rejected
- Domains outside `allowed_domains_for_redirects` → automatically rejected
- eval/innerHTML/dangerouslySetInnerHTML → automatically rejected
- Payment-key / price-id modifications → automatically rejected

## Cumulative Learning

```bash
# After each Kill or Ship
node scripts/funnel-automation/feedback-loop.mjs --ingest
```

This updates `patterns.json` with what worked / what failed. The next agent prompt automatically includes:
> "Past failures to avoid: <patterns>"
> "Past successes to consider: <patterns>"
