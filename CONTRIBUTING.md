# Contributing to funnel-optimize

PRs welcome. Here's what's especially useful.

## High-impact areas

### Data source adapters
Currently PostHog only. Mixpanel / Amplitude / GA4 adapters wanted.

How: extract `createPostHogClient()` interface from `lib.mjs` into an interface; implement new clients matching it.

### Framework examples
Currently `examples/demo` (generic config + dashboard). Wanted: Next.js, Vue, Svelte, plain HTML real-world configs.

How: add `examples/<framework>/` with `funnel-config.json` + sample `useExperiment` hook.

### Discovery prompt improvements
The Discovery interview asks 6 questions. There are surely better questions for B2B SaaS, e-commerce, marketplaces.

How: edit `scripts/discover.mjs` `generateInterviewPrompt()`. Add domain-specific question sets.

### Security scanner patterns
`scanForSecurityIssues()` in `lib.mjs` has a baseline set. Always wanted: more dark-pattern detection, more XSS sinks, framework-specific issues.

## Workflow

1. Fork + branch
2. Test changes against `examples/demo/funnel-config.json` and the `tests/fixtures/dashboard/` fixtures
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

Use `examples/demo/funnel-config.json` as a test config. Dashboard rendering tests use `tests/fixtures/dashboard/` which contains anonymized PostHog snapshot data.

```bash
npm test   # runs node --test against the dashboard fixtures
```

## License

By contributing, you agree your code is licensed under MIT.
