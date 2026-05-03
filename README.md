# 🎯 Funnel Optimize

> **AI-driven funnel optimization for product teams.**
> Triple-agent A/B test design (Claude + Codex + Gemini), weekly cadence, accumulated learning.
> PostHog-powered. MIT license. **Validated on a real 18K-user product.**

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

Then run `/funnel-discover` (one-time setup) and `/funnel-optimize` (weekly).

> Manual install (without plugin): see [Quickstart](#quickstart-5-minutes) below.

---

## Why this exists

You have PostHog data, you have a funnel, you want to run A/B tests systematically. But:

- Setting up the data pipeline takes weeks
- Designing experiments without bias is hard (vanity metrics → false ships)
- Running experiments without accumulating learning means you keep making the same mistakes
- Single-agent AI suggestions miss obvious alternatives

**funnel-optimize** automates the whole loop: data collection → diagnosis → experiment design (3 AI agents compete) → implementation → PR. Then it learns from every kill/ship and feeds patterns back into next week's design.

**Real validation**: animalface.site ran this for 7 weeks with 18,000+ users:
- Weeks 1-4: 5 experiments killed. Lost 4 weeks chasing vanity metrics (CTR proxy without real revenue).
- Week 5+: Pivoted to real-revenue P0 KPI. First paid users in 4 weeks.
- Cumulative pattern: "CTA copy changes alone fail (3-time confirmed). Structural changes work."

See [`examples/animalface/case-study.md`](examples/animalface/case-study.md) for the full 7-week retrospective.

## What it does

### `/funnel-discover` (one-time, 5 minutes)
Analyzes your project + dumps your PostHog events + interviews you about KPIs → generates `funnel-config.json`.

### `/funnel-optimize` (weekly, 30 minutes)
1. **Collect** 7-day PostHog data
2. **Evaluate** active experiment (continue / winner / kill)
3. **Diagnose** funnel bottlenecks + cohort insights
4. **Triple-Agent compete** (Claude / Codex / Gemini suggest experiments)
5. **2-Layer evaluation** (auto-scoring + AI PM review)
6. **Implement** code changes + create PostHog feature flag (with build validation + rollback)
7. **Archive + commit + PR**

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

# 4. Run Discovery (Claude Code will guide you through KPI setup)
node scripts/funnel-automation/discover.mjs

# 5. First weekly run (in Claude Code)
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
                    [next week]
```

## Customization

Everything lives in `funnel-config.json`:

| Field | Purpose |
|-------|---------|
| `optimization_targets[]` | Your KPIs (impression event, click events, target rate, priority) |
| `guardrails.allowed_files` | Which files AI agents can modify |
| `guardrails.allowed_domains_for_redirects` | Domain whitelist for fetch/redirect |
| `multi_agent.agents` | Which agents to run (claude required, codex/gemini optional) |
| `value_metrics` | LIR / Time-to-Value / Health Rollup definitions |

See [`docs/customization.md`](docs/customization.md) for the full schema.

## Documentation

- [Architecture](docs/architecture.md) — 7-Phase pipeline + Triple-Agent design
- [Discovery mode](docs/discovery-mode.md) — first-time setup
- [Operate mode](docs/operate-mode.md) — weekly workflow
- [Customization](docs/customization.md) — funnel-config.json schema
- [Learnings](docs/learnings.md) — patterns from animalface (and yours, over time)
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
- [ ] v0.4: GitHub Action for weekly automation

## Real example: animalface.site

7 weeks. 18,000 users. 5 experiments killed. 1 ship→revert. 1 success signal.

Read [`examples/animalface/case-study.md`](examples/animalface/case-study.md) — including the 4-week vanity-metric mistake we made and how the pipeline detected it.

## License

MIT — see [LICENSE](LICENSE).
