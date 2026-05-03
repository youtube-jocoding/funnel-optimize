# Changelog

All notable changes to funnel-optimize will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-03

First public release. Extracted from animalface.site's funnel automation, generalized for any PostHog + Claude Code project.

### Added

- **Discovery mode** (`scripts/discover.mjs`) — 4-phase first-time setup:
  - D-1: Project analysis (framework / language / payment libraries / active components)
  - D-2: PostHog event catalog dump (top by volume / revenue-related / activation-related)
  - D-3: KPI interview prompt generation (for Claude Code to ask user 6 questions)
  - D-4: `funnel-config.json` auto-generation from interview answers
- **Operate mode** — 7-Phase weekly pipeline:
  - Phase 1: `collect-data.mjs` + `evaluate-experiment.mjs`
  - Phase 2: Diagnostic analysis (Claude reads snapshot, writes report)
  - Phase 3: Triple-Agent experiment design (Claude + Codex + Gemini in parallel)
    - Layer 1: `compare-proposals.mjs` automated scoring (100 points across 8 dimensions)
    - Layer 2: `synthesize-winner.sh` AI PM judgment (6 dimensions, can flip Layer 1)
  - Phase 4: `implement-experiment.mjs` (apply code + create PostHog flag + auto-rollback)
  - Phase 5/5-C: Result analysis + code cleanup (remove `useExperiment()`)
  - Phase 7: `archive.mjs` + git commit + PR
- **Triple-Agent orchestration** with optional CLI fallback:
  - Claude required (orchestrator hard-fails without it)
  - Codex/Gemini optional — auto-skipped with `[INFO]` log if not installed
- **Security scanner** in `lib.mjs` `scanForSecurityIssues()`:
  - Detects eval/Function/innerHTML/document.cookie/script-tag/Stripe-key patterns
  - Domain whitelist configurable via `funnel-config.json` `guardrails.allowed_domains_for_redirects`
- **Guardrail validator** in `lib.mjs` `validateGuardrails()`:
  - File whitelist with **glob pattern support** (`src/components/*.tsx`, `src/**/*.tsx`)
  - Dark pattern detection (fake urgency, fake social proof, deceptive buttons)
  - Max code changes limit
- **Cumulative learning** via `feedback-loop.mjs --ingest`:
  - Records Kill/Ship outcomes to `.funnel-state/patterns.json`
  - Past patterns auto-injected into next week's agent prompts
- **Skill packaging** for Claude Code (`skill/SKILL.md`)
  - `/funnel-discover` and `/funnel-optimize` slash commands
- **Docs** — README, architecture, discovery-mode, operate-mode, customization, learnings, FAQ, CONTRIBUTING
- **Case study** — `examples/animalface/` with 7-week retrospective (18,000 users, 5 experiments killed, 1 ship-and-revert, 1 success signal)

### Validated by dogfood

Three rounds of validation against the original animalface.site project caught and fixed real bugs before public release:

- **`collect-data.mjs` healthRollup heuristic** — `funnel.steps.slice(4)` fallback misclassified `offerwall_redirect` (auto-redirect) as user activation, inflating "activated" rate to 73% instead of correct 1.7%. Fix: prefer `value_metrics.lir.events` (activation events by definition) as fallback.
- **`compare-proposals.mjs` i18n coverage check** — Hardcoded ko/en/ja language patterns caused false "Limited i18n coverage" warnings for OSS users with different language sets. Fix: read `config.project.languages` from `funnel-config.json`; skip check entirely for unconfigured projects.
- **`discover.mjs` payment library detection** — Only inspected frontend `package.json`, missing payment SDKs in backend Cloud Run / API services. Fix: scan `backend/`, `server/`, `api/`, `cloudrun/`, `functions/` directories + `.env.example` / `Dockerfile` / `cloudrun.yaml` for STRIPE_/IAMPORT_/TOSS_/PORTONE_/PAYPAL_ prefixes.
- **Layer 2 AI PM judgment validated** — caught a Skip-the-Wait dark pattern that Layer 1 (automated scoring 85/100) missed, demonstrating the strategic value of two-stage evaluation.

### Limitations

- **PostHog only** — Mixpanel / Amplitude / GA4 adapters not yet implemented (v0.2 candidate)
- **No npm package** — install via `git clone` + `cp scripts/`
- **No GitHub Action** — automation triggered manually via Claude Code or cron

### Roadmap

- v0.2: Plugin interface for data sources (Mixpanel, Amplitude, GA4)
- v0.3: npm package + CLI installer
- v0.4: GitHub Action for weekly automation

[0.1.0]: https://github.com/youtube-jocoding/funnel-optimize/releases/tag/v0.1.0
