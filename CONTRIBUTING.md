# Contributing to funnel-optimize

PRs welcome. Here's what's especially useful.

## High-impact areas

### Data source adapters
Currently PostHog only. Mixpanel / Amplitude / GA4 adapters wanted.

How: extract `createPostHogClient()` interface from `lib.mjs` into an interface; implement new clients matching it.

### Framework examples
Currently `examples/animalface` (React + Astro). Wanted: Next.js, Vue, Svelte, plain HTML.

How: add `examples/<framework>/` with funnel-config.json, sample useExperiment hook, and case study.

### Discovery prompt improvements
The Discovery interview asks 6 questions. There are surely better questions for B2B SaaS, e-commerce, marketplaces.

How: edit `scripts/discover.mjs` `generateInterviewPrompt()`. Add domain-specific question sets.

### Security scanner patterns
`scanForSecurityIssues()` in `lib.mjs` has a baseline set. Always wanted: more dark-pattern detection, more XSS sinks, framework-specific issues.

## Workflow

1. Fork + branch
2. Test changes against `examples/animalface/funnel-config.json` (it's a real-world config)
3. Run `node --check scripts/*.mjs` and `bash -n scripts/*.sh`
4. Open PR with:
   - What problem you're solving
   - How you tested
   - Backwards compatibility note (config schema changes especially)

## Code style

- Node 18+ (no transpilation, native ES modules)
- No npm dependencies — use built-ins
- Bash 4+ POSIX compatible
- Korean or English comments (the codebase uses both)

## Testing without a real project

Use `examples/animalface/funnel-config.json` as a test config. Snapshots in `examples/animalface/` are real PostHog data anonymized.

## License

By contributing, you agree your code is licensed under MIT.
