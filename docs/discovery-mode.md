# Discovery Mode (first-time setup)

Run this once when setting up funnel-optimize for a new project. Output: `funnel-config.json` filled with your project's KPIs.

## Prerequisites

- `.env` configured with `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`
- Project's PostHog has at least 7-30 days of event history
- Claude Code CLI installed (required for D-3 interview)

## Usage

```bash
# Full flow (recommended)
node scripts/funnel-automation/discover.mjs

# Or step by step:
node scripts/funnel-automation/discover.mjs --phase D-1  # Project analysis
node scripts/funnel-automation/discover.mjs --phase D-2  # PostHog event catalog
node scripts/funnel-automation/discover.mjs --phase D-3  # Generate interview prompt
# (Claude Code asks user the questions, collects answers, then:)
node scripts/funnel-automation/discover.mjs --phase D-4 --interview-result '<JSON>'
```

## What each phase does

### D-1: Project Analysis
- Reads `package.json` to detect framework (React/Next/Astro/Vue/Svelte)
- Detects payment libraries (Stripe / Iamport / Toss / PortOne / PayPal)
- Lists most-changed components in last 30 days
- Output: `.funnel-state/discover-d1.json`

### D-2: PostHog Event Catalog
- Queries PostHog for top events (volume, revenue-related, activation-related)
- Output: `.funnel-state/discover-d2.json`

### D-3: KPI Interview
- Generates a markdown prompt for Claude Code to ask the user 6 questions
- Output: `.funnel-state/discover-d3-interview-prompt.md`

The 6 questions:
1. North Star metric
2. **Real revenue event** (NOT proxy/click — actual payment event)
3. Value moment event (when user experiences core value)
4. 1-3 KPIs to optimize (impression event, click events, target rate, priority)
5. allowed_files (paths or globs the AI can modify)
6. allowed_domains_for_redirects (fetch/redirect whitelist)

### D-4: Config Generation
- Takes interview answers + D-1/D-2 outputs
- Writes `funnel-config.json`
- Backs up existing config to `funnel-config.json.bak` if present

## After Discovery

1. Review `funnel-config.json` — adjust target rates, add more KPIs
2. Run first dry-run:
   ```bash
   node scripts/funnel-automation/collect-data.mjs --days 7
   ```
3. Verify KPI dashboard prints with sensible numbers
4. Start weekly loop with `/funnel-optimize`

## Re-running

Discovery is idempotent. Re-run anytime to refresh project analysis or add KPIs.

`funnel-config.json` is backed up to `.bak` before overwrite. Manual edits are preserved if you skip D-4.
