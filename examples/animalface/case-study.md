# Case Study: animalface.site (7-week retrospective)

> 18,000+ users. 7 experiments. 5 killed. 1 ship→revert. 1 success signal. The 4-week mistake that taught us "real revenue over vanity."

## Project context

- **animalface.site**: AI animal face matcher (React + Astro + TypeScript)
- **Revenue**: Premium analysis ($3.49)
- **Traffic**: ~880 UV/day, 83% mobile
- **Period**: 2026-03-13 to 2026-05-03 (7 weeks)

## Timeline

| Week | Experiment | Approach | Result | Learning |
|------|------------|----------|--------|----------|
| 1 (3/13) | Premium CTA reframe | Copy + position | Kill (measurement broken) | PostHog flag config error |
| 2 (3/22) | Progress CTA (Zeigarnik) | Copy + design | Kill (-43.7%) | Progress framing backfired |
| 3 (3/29) | Share Compare 3-variant | Copy multivariate | Kill (control 1.34% won) | **3 copy-only failures** → structural needed |
| 4 (4/5) | Offerwall Share Bundle | Structural (timing) | Kill (Premium guardrail -87%) | Share & Premium attention compete |
| 5 (4/12) | Premium Skip-the-Wait | Structural (during wait) | Ship → Revert | **+521% CTR but 0 actual payments** |
| 6 (4/19) | Wait Screen Share Revival | Structural (clone surface) | Kill (0 days, vanity-based design) | **The vanity metric reckoning** |
| 7 (4/26) | Premium-First Layout | Structural (chart-adjacent) | **Continue** (first paid: 2 vs 0) | **First real revenue signal** |

## The 4-week vanity metric mistake

Weeks 1-4 we optimized `premium_cta_ctr`. We thought "click-through rate" was a reasonable proxy for revenue.

**It was not.**

In Week 5, we shipped Premium Skip-the-Wait based on +521% CTR. It looked great on the dashboard. We declared victory.

12 days later we noticed: PostHog `premium_paid` event = 0 for the entire ship period. Stripe webhook had been broken since 4/7. We never knew because we were measuring clicks, not money.

Three things broke at once:
1. Stripe webhook outage (real outage)
2. Vanity metric (`premium_checkout` event firing on Stripe redirect, NOT on payment completion)
3. AI confidence (the dashboard said "+521%" so we trusted it)

## The pivot (Week 5 retro)

Added `premium_paid` event (fires on Stripe success URL → /analysis/{id} page render). This is the closest frontend proxy for actual revenue.

Reordered KPI priorities:
- P0: `premium_paid_rate` (real revenue)
- P0: `checkout_paid_rate` (system health — exposes payment outages)
- P2 (downgraded): `premium_cta_ctr` (proxy only)

Reverted the Skip-the-Wait Ship.

## Week 7 result (first signal)

Premium-First Layout (chart → Premium teaser inline → share → existing Premium card):

| Metric | Control (5,632 users) | Test (5,931 users) | Lift |
|--------|---|---|---|
| premium_paid | 0 | **2** | ∞ (first signal in 4 weeks) |
| premium_click | 7 | 78 | +955% |
| premium_checkout | 8 | 52 | +517% |
| Share Total CTR | 1.69% | 1.13% | -33.3% (guardrail violation) |

Decision: **Continue**, not Ship. p=0.1682 (not statistically significant). Real revenue signal exists but tiny baseline.

## Patterns from this case

These are general patterns, encoded in `docs/learnings.md`:

1. **Vanity metrics will lie** — measure real revenue
2. **Copy changes alone fail** when there's structural absorption (Offerwall ate 98% of traffic)
3. **Structural changes work** when they fit the user's mental flow (chart-adjacent Premium teaser at peak curiosity moment)
4. **Payment system outages mask as UX failures** — guard with `checkout_paid_rate` system KPI
5. **Statistical significance is hard** at low revenue baselines — combine with directional + guardrails

## What this case study does NOT prove

- Generalizability to B2B SaaS (different sales cycle)
- Generalizability to high-LTV products (different optimization unit)
- That structural > copy in all contexts (it didn't work in Week 4 when both surfaces competed)

Treat this as one data point. Your project's `patterns.json` will accumulate yours.
