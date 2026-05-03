# Funnel Dashboard — Design Spec

**Date**: 2026-05-03
**Owner**: funnel-optimize maintainers
**Status**: design approved, pending implementation plan

## Goal

Add a visual funnel dashboard that lets a product team see — at a single glance — every step's metrics, conversion rates (including purchase), and whether things are improving. Replaces the markdown-table-only experience that exists today.

The dashboard answers three questions in one view:

1. **Are we getting better?** (week-over-week trend)
2. **Where's the bottleneck?** (current funnel vs target)
3. **Is this experiment winning?** (active A/B Test vs Control side-by-side)

## Non-goals

- Not a live dashboard. It's regenerated on each weekly run; freshness == latest snapshot.
- Not a replacement for PostHog. It visualizes funnel-optimize's snapshots, not raw events.
- Not a configuration UI. Editing funnel/KPI definitions still happens in `funnel-config.json`.
- Not a multi-project portal. Single project, single dashboard, single HTML file.

## Architecture

A new script reads existing state files and writes one self-contained HTML file:

```
.funnel-state/                              docs/funnel-archive/
├── latest-snapshot.json            ─┐
├── weekly-snapshot-*.json          ─┤
├── state.json (active + history)   ─┼──▶ render-dashboard.mjs ──▶ dashboard.html
├── evaluation-result.json          ─┤                              (one file,
└── experiment-plan.json            ─┘                               inlined data,
                                                                     no external deps)
```

**Constraints honored**:

- Zero runtime deps (Node 18+, native fetch, no `npm install` required) — matches the project's existing philosophy.
- Self-contained output: inline CSS, inline SVG, vanilla JS, JSON data embedded in a `<script type="application/json">` block. No CDNs, no fetches. Works offline, on `file://`, and on GitHub Pages.
- Idempotent: running it twice produces the same HTML modulo input data.

**Pipeline integration**:

- New `npm run dashboard` script runs `render-dashboard.mjs` standalone.
- `archive.mjs` calls it as its final step so each weekly run refreshes `dashboard.html`.

## Page layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  HEADER                                                                  │
│  Funnel Optimize · 2026-05-03 · 7-day window                             │
│  [North Star tile: weekly paid users — current vs prior week]            │
│  [P0 KPI tiles: Premium Paid Rate · Checkout→Paid · ...]                 │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  ① TREND — last N weeks                                                  │
│  Line chart per funnel-step rate. x = week, y = rate.                    │
│  Toggleable lines. Latest week annotated with ▲/▼ vs prior week.         │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  ② CURRENT FUNNEL — this week                                            │
│  Horizontal funnel bars, one per step.                                   │
│    width ∝ users · drop-off arrows between steps · purchase highlighted  │
│    target tick + status pill on the right                                │
│  Linear / log toggle for tiny final-step counts.                         │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  ③ ACTIVE EXPERIMENT — Control vs Test                                   │
│  Two parallel funnels side by side. Lift % per step. p-value, decision,  │
│  guardrail status in footer. Hidden if no active experiment.             │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  ④ EXPERIMENT HISTORY (compact)                                          │
│  Past experiments table from state.history[].                            │
└──────────────────────────────────────────────────────────────────────────┘
```

## Visual treatment

- Clean and dense. Linear/Vercel aesthetic, not chart-junk.
- Monochrome surfaces, single accent color, status palette only for status.
- Color semantics:
  - **Green** — meeting target / positive lift / shipping signal
  - **Amber** — within reach but missing target / inconclusive
  - **Red** — far below target / negative lift / guardrail violation
  - **Blue** — neutral accent (primary chart line, North Star)
  - **Gray** — past-week / context data
- Funnel bars: inline SVG with width proportional to user count. Linear by default; auto-flip to log scale when the smallest non-zero step is <1% of the largest, with a manual toggle.
- Drop-off arrows between bars carry both absolute (`-3,961 users`) and percentage (`-83.7%`).
- Progress to target: thin track behind each bar showing `current / target` with a tick at target. Status pill (🟢/🟡/🔴 + label) on the right.
- Trend chart: minimalist line chart, vanilla SVG. Latest data point annotated with delta. Empty/missing weeks render as gaps, not zeros.
- A/B section: two funnels rendered identically side-by-side. Lift column color-coded. p-value rendered with explicit interpretation (`p=0.17 — not significant`) so it can't be misread the way the case study describes.
- Empty/missing data: every section degrades cleanly.
- Desktop-first; readable on tablet; mobile is best-effort.
- No external assets. All CSS inline, all icons inline SVG or unicode (▲ ▼ ●), zero CDN calls.

## Data flow

**Files read** (all already produced by the existing pipeline):

| File | Used for | Required? |
|---|---|---|
| `funnel-config.json` | funnel step order, target values, KPI definitions, North Star | yes |
| `.funnel-state/latest-snapshot.json` | current week's funnel + KPI + variant data | yes |
| `.funnel-state/weekly-snapshot-*.json` | trend section (historical data points) | optional — section hides if <2 |
| `.funnel-state/state.json` | active experiment metadata, history table | optional |
| `.funnel-state/evaluation-result.json` | p-value and decision for active experiment | optional |
| `.funnel-state/experiment-plan.json` | variant label/description (Control vs Test) | optional |

**Render pipeline**:

1. Load config + state files. If `latest-snapshot.json` is missing, print `"no snapshot found, run 'npm run collect' first"` and exit non-zero.
2. Build the **funnel model**: walk `config.funnel.steps` in order; for each step look up the user count from `snapshot.funnel.results` (which is `[[step, users], ...]`). First step is the 100% baseline. Compute rate-from-first and step-to-step drop-off.
3. Tag the **purchase step**. Heuristic: the funnel step matching the `click_events[]` of the highest-priority `optimization_targets[]` entry that has `priority: "P0"` and `direction: "higher"`. Fallback: the last step in `funnel.steps`. Console warning if heuristic misses, so the user can fix config.
4. Build the **trend model**: glob `weekly-snapshot-*.json` sorted ascending by date. For each historical snapshot, recompute the same per-step **cumulative rate** (users-at-step / users-at-first-step) and the P0 KPI rates. The trend chart plots these cumulative rates per week so "improvement" reads correctly: a line moving up = more users surviving from page-view to that step. Skipped entirely if fewer than 2 weekly snapshots exist.
5. Build the **A/B model** from `snapshot.experiment_variants.results` (rows of `[variant, event, count, users]`): group by variant, walk funnel steps, compute per-variant rate. Lift = `(test − control) / control`. p-value taken from `evaluation-result.json` when available; otherwise computed inline with a two-proportion z-test (zero deps, just math). Section hidden when no variant data exists.
6. Emit `docs/funnel-archive/dashboard.html` with all data inlined as `<script type="application/json" id="data">…</script>` plus a small vanilla-JS bootstrap that reads the JSON and renders SVGs, tooltips, and the linear/log toggle.

## Edge cases

| Case | Behavior |
|---|---|
| `latest-snapshot.json` missing | Hard exit with actionable message |
| Single snapshot, no history | Trend section replaced with "Run for 2+ weeks to see trends" |
| First funnel step has 0 users | Bars render at "N/A", drop-off math suppressed |
| Funnel step missing from snapshot | Rendered as 0 users with "no events" caveat |
| Variant data exists, one side has 0 impressions | Lift = "—" (not Infinity); rate shown as 0.0% |
| Smallest non-zero step <1% of largest (e.g., paid users) | Auto-default to log scale; manual toggle preserved |
| No active experiment | A/B section + active-experiment header hidden cleanly |
| p-value sample too small (n<30 per side) | Explicit "sample too small for inference" badge instead of misleading p-value |
| Purchase-step heuristic finds nothing | Fall back to last step; emit console warning naming the config field to fix |

## Components / file boundaries

The script splits into small, independently testable units:

| Unit | Responsibility | Inputs | Outputs |
|---|---|---|---|
| `loadInputs()` | Read all state files; resolve config; surface "no data" errors | filesystem | `{ config, snapshot, history[], state, evaluation, plan }` |
| `buildFunnelModel()` | Walk config.funnel.steps, compute rates and drop-offs | config + snapshot | `FunnelStep[]` with `{ name, users, rate, dropFromPrev, isPurchase, target, status }` |
| `buildTrendModel()` | Compute per-week step rates from historical snapshots | config + history | `WeekRow[]` |
| `buildExperimentModel()` | Group variant rows by variant, compute lift, pull or compute p-value | snapshot + evaluation + plan | `{ control: FunnelStep[], test: FunnelStep[], lift[], pValue, decision }` or `null` |
| `pValueTwoProp()` | Pure-math two-proportion z-test → p-value | `(c1, n1, c2, n2)` | `{ p, zScore }` or `null` if undersized |
| `renderHTML()` | Assemble HTML, inline data block, inline CSS, inline JS bootstrap | all models + config | HTML string |
| `main()` | CLI entrypoint: orchestrate, write file, print path | argv | exit code |

The browser-side JS is intentionally tiny (~150 lines): read the embedded JSON, render funnel/trend/AB SVGs, attach tooltips and linear-log toggle. No frameworks.

## Configuration extensions

Add an optional `dashboard` block to `funnel-config.json` (all keys have sensible defaults; the dashboard works without any config change):

```json
{
  "dashboard": {
    "trend_weeks": 8,
    "purchase_step_override": null,
    "default_scale": "auto"
  }
}
```

| Key | Default | Purpose |
|---|---|---|
| `trend_weeks` | 8 | Cap how many historical weeks the trend chart shows |
| `purchase_step_override` | `null` | Force a specific funnel step as the purchase step (bypasses heuristic) |
| `default_scale` | `"auto"` | `"linear"`, `"log"`, or `"auto"` (decide based on min/max ratio) |

## Testing strategy

- **Unit-testable pure functions** (`buildFunnelModel`, `buildTrendModel`, `buildExperimentModel`, `pValueTwoProp`) covered with hand-built fixtures derived from the animalface example, plus edge-case fixtures (empty snapshot, single-week history, missing variant data, zero-impression variant, undersized sample).
- **Snapshot test on rendered HTML**: render against animalface fixture, assert that key sections (`#funnel-current`, `#funnel-trend`, `#funnel-experiment`) exist or are explicitly hidden.
- **Manual smoke**: open the generated `dashboard.html` in a browser; verify the linear/log toggle, tooltips, and the `file://` open path all work.

## Rollout

1. Land `scripts/render-dashboard.mjs` + tests + `npm run dashboard`.
2. Wire it into `archive.mjs` as the last step.
3. Generate the dashboard from the animalface example fixture, commit `examples/animalface/dashboard.html` so the public repo has a viewable demo.
4. Add a "Visual Dashboard" section to README pointing at the demo URL via GitHub Pages or raw HTML preview.

## Open questions (none blocking)

- Whether to expose `dashboard.html` via GitHub Pages on the funnel-optimize repo itself (vs leaving it as raw-viewable). Tracked separately; doesn't block v1.
- Long-term: a per-week archive variant (`dashboard-YYYY-MM-DD.html`) was rejected for v1 to avoid noise, but could be reintroduced later if users want to scrub through history.
