# Architecture

## 7-Phase Pipeline

The pipeline is run on demand (no fixed cadence). Discovery sizes a per-project `experiment_window_days` from your DAU; significance can fire earlier. Each phase has a clear input, output, and decision rule.

### Phase 1: Data Collection + Experiment Evaluation
- **Inputs**: PostHog API, last `experiment_window_days` of events (from config), current `state.json`
- **Outputs**: `weekly-snapshot-{date}.json` (filename retained for backwards compat), `evaluation-result.json`
- **Decision**: `none` / `continue` / `winner_test|control` / `killed`

### Phase 2: Diagnostic Analysis
- **Inputs**: snapshot.json
- **Outputs**: appended section in `FUNNEL_OPTIMIZATION_REPORT.md`
- **Done by**: Claude Code reading snapshot + writing structured analysis

### Phase 3: Triple-Agent Experiment Design
- **Inputs**: snapshot, evaluation, history, config
- **Outputs**: 3 proposals (claude/codex/gemini), 1 selected experiment plan
- **Decision**: 2-Layer evaluation (Layer 1 auto-score + Layer 2 AI PM)

### Phase 4: Experiment Implementation
- **Inputs**: experiment-plan.json
- **Outputs**: code changes applied, PostHog feature flag created
- **Safety**: build validation + auto-rollback on failure

### Phase 5: Result Analysis (only when experiment ends)
- **Inputs**: variant CTRs, statistical test
- **Outputs**: Ship / Extend / Kill decision in report
- **Critical rule**: judge by **real revenue**, not proxy CTR

### Phase 5-C: Code Cleanup (Kill or Ship)
- Remove `useExperiment()` calls
- Keep only the winning variant code
- Disable PostHog flag

### Phase 6: Growth Loop (quarterly)
- Evaluate Viral / UGC / Usage / Referral / Collaboration loops

### Phase 7: Archive + Commit
- archive.mjs writes a per-cycle report
- git commit + PR (branch `funnel/{flag-key}`)

## Triple-Agent Architecture

```
                    ┌────────────────┐
                    │ funnel-config  │
                    │ + snapshot     │
                    │ + state        │
                    └────────┬───────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  ┌──────────┐         ┌──────────┐         ┌──────────┐
  │ Claude   │         │ Codex    │         │ Gemini   │
  │ (req'd)  │         │ (opt)    │         │ (opt)    │
  └────┬─────┘         └────┬─────┘         └────┬─────┘
       │                    │                    │
       ▼                    ▼                    ▼
  proposal/claude/    proposal/codex/    proposal/gemini/
  (analysis,          (analysis,          (analysis,
   discovery,          discovery,          discovery,
   plan.json)          plan.json)          plan.json)
       │                    │                    │
       └────────────────────┼────────────────────┘
                            ▼
              ┌──────────────────────────┐
              │ Layer 1: auto-scoring    │
              │ (compare-proposals.mjs)  │
              │ — 100 points across      │
              │   completeness, schema,  │
              │   code, guardrails, etc. │
              └────────┬─────────────────┘
                       ▼
              ┌──────────────────────────┐
              │ Layer 2: AI PM judgment  │
              │ (synthesize-winner.sh)   │
              │ — 6 dimensions, can      │
              │   flip Layer 1 ranking   │
              └────────┬─────────────────┘
                       ▼
                  experiment-plan.json
                  (selected winner)
```

## Why Triple-Agent?

- **Single agent has blind spots**. Claude tends toward conservative structural changes; Codex toward bold UX redesigns; Gemini toward copy/framing variations.
- **Competition exposes mistakes**. Layer 2 has historically caught dark-pattern proposals (e.g. fake discounts) that Layer 1's automated scoring rated highly.
- **Optional fallback**. If only Claude is installed, the pipeline runs single-agent (Layer 2 still applies).

## State Files

```
.funnel-state/
├── state.json                    # active experiment + history
├── latest-snapshot.json          # most recent collection
├── weekly-snapshot-YYYY-MM-DD.json
├── evaluation-result.json        # Phase 1 output
├── experiment-plan.json          # Phase 3 winner
├── implementation-summary.json   # Phase 4 output
├── patterns.json                 # accumulated learning
└── proposals/
    ├── claude/
    ├── codex/
    ├── gemini/
    ├── comparison-result.json    # Layer 1 scores
    └── next-candidate.json       # 2nd place (preserved for next week)
```

## Code Modules

| File | Responsibility |
|------|----------------|
| `lib.mjs` | PostHog client, env, state, security scanner, guardrail validator |
| `discover.mjs` | Discovery mode (D-1~D-4) |
| `collect-data.mjs` | Phase 1 data |
| `evaluate-experiment.mjs` | Phase 1 decision |
| `compare-proposals.mjs` | Phase 3-D Layer 1 |
| `implement-experiment.mjs` | Phase 4 |
| `archive.mjs` | Phase 7 |
| `feedback-loop.mjs` | Pattern accumulation |
| `orchestrate-triple-agent.sh` | Phase 3 orchestrator + CLI fallback |
| `run-{claude,codex,gemini}-agent.sh` | Per-agent runners |
| `synthesize-winner.sh` | Layer 2 |
| `render-dashboard.mjs` | Visual funnel dashboard (HTML output) |
