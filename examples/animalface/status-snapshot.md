# Status Snapshot — Week 7 (2026-05-03)

This is what `FUNNEL_STATUS.md` looks like after a typical weekly run. Use it as a template.

## North Star Metric

| Indicator | Current | Target | Notes |
|-----------|---------|--------|-------|
| Weekly paid users | 2 (Test variant only) | growth | First signal after 4 weeks |
| Daily UV | ~898 | growth | +14% WoW |
| Upload Rate | 84.0% | 85%+ | +3.0%p |
| Premium Paid Rate | 0.02% | 1.0% | Baseline still tiny |
| Checkout → Paid | 3.33% | 50% | System partially recovered |

## KPI Dashboard

| KPI | Current | Target | WoW | Status |
|-----|---------|--------|-----|--------|
| Premium Paid Rate (P0, real revenue) | 0.02% | 1.0% | 0% | 🔴 |
| Checkout → Paid Conversion (P0) | 3.33% | 50% | +3.33%p | 🟡 |
| Premium CTA CTR (P2 proxy) | 2.28% | 4.0% | +2.06%p ↑ | 🟡 |
| Share Total CTR (P3) | 1.45% | 8.0% | -0.35%p ↓ | 🔴 |

## Active Experiment

### Premium-First Result Layout

| Field | Value |
|-------|-------|
| Flag | `funnel-exp-20260426-premium-first-layout` |
| Started | 2026-04-26 |
| Days | 6/14 |
| Decision | **continue** (p=0.1682) |
| Test result | premium_paid 2/5,931 (0.0337%) vs Control 0/5,632 (0%) |
| Guardrail status | ⚠️ Share -33.3% (limit -30%) |
