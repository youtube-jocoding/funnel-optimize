# Customization Guide

Everything customizable lives in `funnel-config.json`.

## Schema

```jsonc
{
  "project": {
    "name": "your-project",
    "framework": "react|astro|next|vue|svelte",
    "north_star": {
      "metric": "weekly_paid_users",
      "target": "growth"
    }
  },
  "automation": {
    "enabled": true,
    "auto_merge": false,
    "max_concurrent_experiments": 1,
    "min_sample_size": 500,
    "significance_level": 0.05,
    "min_early_decision_days": 0,           // calendar floor; 0 = no floor (apply on significance immediately)
    "experiment_window_days": 7,            // DAU-derived during /funnel-discover
    "max_experiment_days": 28,              // hard cap; force decision at this point
    "expected_dau": null,                   // recorded by /funnel-discover (informational)
    "min_detectable_lift_pct": 10           // recorded by /funnel-discover (informational)
  },
  "optimization_targets": [
    {
      "kpi": "payment_completed_rate",       // Internal KPI key
      "metric_name": "Payment Completed Rate", // Display name
      "impression_event": "result_view",      // PostHog event for denominator
      "click_events": ["payment_completed"],  // PostHog events for numerator (sum)
      "current": 0,                           // baseline rate (auto-updated)
      "target": 1.0,                          // goal rate (%)
      "priority": "P0",                       // P0 (real revenue) | P1-P5
      "direction": "higher",                  // higher | lower
      "device_filter": null                   // null | "Mobile" | "Desktop" | "Tablet"
    }
  ],
  "funnel": {
    "steps": ["$pageview", "result_view", "payment_completed"]
  },
  "guardrails": {
    "no_dark_patterns": true,
    "no_fake_urgency": true,
    "no_fake_social_proof": true,
    "preserve_accessibility": true,
    "max_code_changes": 5,
    "allowed_files": [
      "src/components/*.tsx",
      "src/lib/translations.ts"
    ],
    "allowed_domains_for_redirects": ["yoursite.com", "localhost"]
  },
  "multi_agent": {
    "enabled": true,
    "agents": ["claude", "codex", "gemini"],
    "timeout_seconds": 1800,
    "scoring_weights": {
      "completeness": 15,
      "schema_validity": 20,
      "code_validity": 25,
      "guardrail_compliance": 15,
      "kpi_alignment": 10,
      "novelty": 10,
      "analysis_depth": 5
    }
  },
  "value_metrics": {
    "lir": { /* Leading Indicator of Retention */ },
    "time_to_value": { /* TTV milestones */ },
    "health_rollup": { /* Activated/Completed/Stuck/Bounced */ }
  },
  "posthog": {
    "host": "https://us.i.posthog.com",
    "feature_flag_prefix": "funnel-exp-"
  }
}
```

## Common Customizations

### Adding a new KPI

```json
{
  "kpi": "newsletter_signup_rate",
  "metric_name": "Newsletter Signup Rate",
  "impression_event": "result_view",
  "click_events": ["newsletter_subscribe"],
  "current": 0,
  "target": 5.0,
  "priority": "P2",
  "direction": "higher"
}
```

### Restricting AI to specific files

`allowed_files` supports exact paths or glob patterns:
- `"src/components/Result.tsx"` — exact
- `"src/components/*.tsx"` — single-level wildcard
- `"src/**/*.tsx"` — recursive wildcard

### Disabling Triple-Agent (Claude only)

```json
"multi_agent": {
  "enabled": false,
  "agents": ["claude"]
}
```

### Custom checkout error tracking

```json
"checkout_error_events": {
  "success": "payment_completed",
  "error": "payment_failed"
}
```

This lets `collect-data.mjs` compute Checkout Error Rate.

### EU PostHog

```bash
# .env
POSTHOG_HOST=https://eu.i.posthog.com
```

## What you should NOT change without understanding

- `min_sample_size: 500` — going below 200 risks false positives
- `significance_level: 0.05` — standard. 0.01 means longer experiments
- `max_concurrent_experiments: 1` — multi-experiment causes flag conflicts
- `scoring_weights` — Layer 1 was tuned on a real-world product. Adjust gradually.

## How `experiment_window_days` is computed

During `/funnel-discover` D-4, the script asks for your DAU on the primary impression event and computes:

```
experiment_window_days = clamp(ceil(min_sample_size / DAU), 3, max_experiment_days)
```

This is the *target* window. The actual experiment terminates as soon as significance is reached (`min_sample_size + p < significance_level`), which is often earlier than the window. Set `min_early_decision_days > 0` if you want a hard calendar floor for novelty / day-of-week effects.

## Migrating from existing experiment infra

If you already have PostHog feature flags:
1. Funnel-optimize creates flags with prefix `funnel-exp-`
2. Existing flags untouched
3. Manual cleanup of old flags via PostHog UI
