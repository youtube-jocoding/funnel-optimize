# 🎯 Funnel Optimize

> **AI-driven funnel optimization for product teams.**
> Triple-agent A/B test design (Claude + Codex + Gemini), DAU-aware experiment windows, accumulated learning.
> PostHog-powered. MIT license.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Release](https://img.shields.io/github/v/release/youtube-jocoding/funnel-optimize?color=blue)](https://github.com/youtube-jocoding/funnel-optimize/releases)
[![GitHub stars](https://img.shields.io/github/stars/youtube-jocoding/funnel-optimize?style=social)](https://github.com/youtube-jocoding/funnel-optimize)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

## ⚡ Install in Claude Code (10 seconds)

```bash
/plugin marketplace add youtube-jocoding/funnel-optimize
/plugin install funnel-optimize@funnel-optimize
```

Then run `/funnel-discover` once, and `/funnel-optimize` whenever you want to advance the experiment cycle.

> Manual install (without plugin): see [Quickstart](#quickstart-5-minutes--manual-install) below.

---

## Why this exists

You have PostHog data, you have a funnel, you want to run A/B tests systematically. But:

- Setting up the data pipeline takes weeks
- Designing experiments without bias is hard (vanity metrics → false ships)
- Running experiments without accumulating learning means you keep making the same mistakes
- Single-agent AI suggestions miss obvious alternatives

**funnel-optimize** automates the whole loop: data collection → diagnosis → experiment design (3 AI agents compete) → implementation → PR. Then it learns from every kill/ship and feeds patterns back into the next experiment.

The cadence isn't fixed. Discovery measures your DAU and computes how long an experiment needs to run to reach significance. As soon as the data crosses the threshold (`min_sample_size` + `p < significance_level`), the winner is applied — no calendar gate.

## What it does

### `/funnel-discover` (one-time, 5 minutes)
Analyzes your project + dumps your PostHog events + interviews you about KPIs and DAU → generates `funnel-config.json` (including a DAU-derived `experiment_window_days`).

### `/funnel-optimize` (per experiment cycle)
Run it whenever you want to advance the loop. The pipeline detects state and acts accordingly:

1. **Collect** PostHog data over the configured window
2. **Evaluate** active experiment — `continue` while collecting, `winner_*` once `min_sample_size + p<significance_level` is reached, `killed` if guardrails trip
3. **Diagnose** funnel bottlenecks + cohort insights
4. **Triple-Agent compete** (Claude / Codex / Gemini suggest experiments)
5. **2-Layer evaluation** (auto-scoring + AI PM review)
6. **Implement** code changes + create PostHog feature flag (with build validation + rollback)
7. **Archive + commit + PR**

## Visual Dashboard

After any run, `dashboard.html` is regenerated with a single command:

```bash
npm run dashboard
```

It produces a self-contained, zero-dep HTML file at `docs/funnel-archive/dashboard.html` with:

- Window-over-window funnel-rate trend (last 8 windows by default)
- Current funnel — every step's users, cumulative rate, drop-off, and KPI gap
- Active experiment — Test vs Control side-by-side with lift and p-value at every step (including purchase)
- Compact experiment history table

`archive.mjs` calls it automatically as its final step. Open the file directly in any browser — no server, no CDN, no build.

A static demo is committed at [`examples/demo/dashboard.html`](examples/demo/dashboard.html).

## Requirements

- **Node 18+** (uses native fetch, no deps)
- **PostHog** (Cloud or self-hosted)
- **Claude Code CLI** (required for AI agents)
- **Codex CLI / Gemini CLI** (optional — auto-fallback to single-agent)
- **Git + GitHub CLI** (for PR creation)

## Quickstart (5 minutes — manual install)

> **Easier:** use the [Claude Code plugin install](#-install-in-claude-code-10-seconds) above. The manual flow is for users who don't have Claude Code or want full control over file locations.

```bash
# 1. Clone funnel-optimize beside your project
git clone https://github.com/youtube-jocoding/funnel-optimize.git ../funnel-optimize

# 2. Copy artifacts into YOUR project
cd /path/to/YOUR-project
mkdir -p scripts/funnel-automation .claude/skills/funnel-optimize
cp -r ../funnel-optimize/scripts/* scripts/funnel-automation/
cp ../funnel-optimize/skills/funnel-optimize/SKILL.md .claude/skills/funnel-optimize/
cp ../funnel-optimize/funnel-config.example.json funnel-config.json
cp ../funnel-optimize/.env.example .env

# 3. Fill in your PostHog credentials
$EDITOR .env  # POSTHOG_API_KEY, POSTHOG_PROJECT_ID

# 4. Run Discovery (Claude Code will guide you through KPI + DAU setup)
node scripts/funnel-automation/discover.mjs

# 5. First run (in Claude Code)
/funnel-optimize
```

## How it works

```
┌─────────────────────────────────────────────────────────┐
│  Phase 1: collect-data.mjs + evaluate-experiment.mjs   │
│  → snapshot.json + decision (continue/winner/kill)     │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Phase 2: Diagnostic analysis (Claude Code reads        │
│  snapshot, identifies bottlenecks, writes report)       │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Phase 3: Triple-Agent compete                          │
│  ├── Claude (PM Skills: /discover /brainstorm)          │
│  ├── Codex CLI (optional)                               │
│  └── Gemini CLI (optional)                              │
│  → 3 proposals scored → 1 winner picked                 │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Phase 4: implement-experiment.mjs                      │
│  → apply code changes + create PostHog flag             │
│  → build validation + auto-rollback                     │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Phase 7: archive.mjs + git commit + gh pr create       │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
                  [significance reached → apply winner;
                   else continue collecting]
```

## Customization

Everything lives in `funnel-config.json`:

| Field | Purpose |
|-------|---------|
| `optimization_targets[]` | Your KPIs (impression event, click events, target rate, priority) |
| `automation.experiment_window_days` | DAU-derived window. Significance can fire earlier. |
| `automation.min_sample_size` / `significance_level` | Significance gates |
| `automation.min_early_decision_days` | Optional calendar floor (default `0` — no floor) |
| `guardrails.allowed_files` | Which files AI agents can modify |
| `guardrails.allowed_domains_for_redirects` | Domain whitelist for fetch/redirect |
| `multi_agent.agents` | Which agents to run (claude required, codex/gemini optional) |
| `value_metrics` | LIR / Time-to-Value / Health Rollup definitions |

See [`docs/customization.md`](docs/customization.md) for the full schema.

## Documentation

- [Architecture](docs/architecture.md) — 7-Phase pipeline + Triple-Agent design
- [Discovery mode](docs/discovery-mode.md) — first-time setup
- [Operate mode](docs/operate-mode.md) — per-cycle workflow
- [Customization](docs/customization.md) — funnel-config.json schema
- [Learnings](docs/learnings.md) — patterns observed in the field
- [FAQ](docs/faq.md)

## Contributing

PRs welcome. Especially:

- Data source adapters (Mixpanel, Amplitude, GA4) — currently PostHog only
- Framework-specific examples (Next.js, Vue, Svelte)
- Better Discovery prompts
- Better security scanner patterns

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- [ ] v0.1 (current): PostHog + Claude/Codex/Gemini Triple-Agent
- [ ] v0.2: plugin interface for data sources
- [ ] v0.3: npm package + CLI
- [ ] v0.4: GitHub Action for scheduled automation

## License

MIT — see [LICENSE](LICENSE).
