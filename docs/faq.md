# FAQ

### Q: Do I need PostHog?
Yes, currently. v0.1 only supports PostHog (HogQL queries). v0.2 will add Mixpanel/Amplitude/GA4 adapters.

### Q: Do I need Claude Code CLI?
Yes, for AI agent work. Codex/Gemini CLIs are optional — pipeline auto-falls back to single-agent.

### Q: Can I use this without Claude Code?
Yes for the data pipeline (Phase 1, 4, 7). No for the AI agent phases (2, 3) — those need an LLM in the loop.

### Q: My PostHog project is on EU. How?
Set `POSTHOG_HOST=https://eu.i.posthog.com` in `.env`.

### Q: What if my project doesn't use feature flags?
funnel-optimize creates them in PostHog automatically. You need to add the `useExperiment()` (or equivalent) hook on your frontend. See `examples/animalface/` for a React/Astro example.

### Q: How long does a weekly run take?
- Without Triple-Agent: 5-10 minutes
- With Triple-Agent (claude+codex+gemini): 15-30 minutes (agents run in parallel, 30-min timeout each)

### Q: What's the difference between this and Optimizely / VWO / GrowthBook?
- They're A/B test platforms. funnel-optimize is an **A/B test designer + decision automator** that uses one of them (currently PostHog) as the underlying platform.
- They give you a UI to define experiments. funnel-optimize **proposes the experiments** based on data analysis + accumulated learning.

### Q: Will this work for B2B SaaS / e-commerce / EdTech?
The pipeline is data-driven, so yes — but `examples/animalface` is a B2C consumer app. Patterns from that case may not generalize. Discovery mode should help you identify your own KPIs.

### Q: Can I disable the Triple-Agent and use only Claude?
Yes:
```json
"multi_agent": {
  "enabled": false,
  "agents": ["claude"]
}
```

### Q: How do I debug a failing experiment?
1. Check `.funnel-state/state.json` for active flag
2. Check PostHog → Feature Flags for active status
3. Check `evaluation-result.json` for last decision
4. Run manual `--kill` to disable: `node scripts/funnel-automation/evaluate-experiment.mjs --kill`

### Q: What if my AI generates bad code?
- Build validation runs after every code change. Failure → auto-rollback.
- Security scanner blocks eval/innerHTML/external fetch.
- Guardrails block dark patterns (fake urgency/social proof).
- File whitelist (`allowed_files`) prevents AI from touching auth/payment/business logic.

### Q: How do I contribute?
PRs welcome — see CONTRIBUTING.md. Especially needed: data source adapters, framework examples, better Discovery prompts.
