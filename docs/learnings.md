# Patterns From the Field

These are patterns that emerged from running funnel-optimize on real projects. Your project will accumulate its own patterns in `.funnel-state/patterns.json` over time. This document captures the meta-patterns — things worth knowing before you start.

## Pattern 1: Vanity metrics will lie to you

**Symptom**: Your "Premium CTA CTR" experiment shows +521% lift. You ship it. Revenue goes... down.

**Root cause**: CTR measures clicks. Clicks ≠ payments. The users you're attracting with louder CTAs are tire-kickers, not buyers.

**Fix**: Set your **P0 KPI to actual revenue events**, not click events. e.g. `payment_completed` (Stripe success URL → success page render) as P0. CTA clicks belong at P2 (proxy) or below.

**How funnel-optimize enforces**: `priority: "P0"` targets dominate Ship/Kill decisions.

---

## Pattern 2: Copy changes alone don't move conversion

**Symptom**: You try 3 different CTA copies. None move the needle. Your team blames the AI.

**Root cause**: When the **structural funnel** has a 98%+ leakage step (e.g., offerwall, modal, redirect), copy changes downstream are noise.

**Fix**: Look at the funnel waterfall. If 90%+ users are absorbed by one step, **change the structure** (timing, surface, position) — not the copy.

**How funnel-optimize enforces**: After 3 consecutive copy-only failures, `patterns.json` records "structural change required" and prompts agents to propose layout/timing/surface changes.

---

## Pattern 3: Real revenue baseline can be tiny

**Symptom**: Your weekly paid users = 2. Statistical significance is laughable.

**Root cause**: Real revenue is harder to move than CTR. With small N, you need much longer experiments OR larger effect sizes.

**Fix**: Run experiments for 14 days minimum (`max_experiment_days: 14`). Use **directional signals + guardrails** to make Continue/Kill decisions when statistical significance isn't reachable.

**How funnel-optimize handles**: Continue while p > 0.05 unless guardrails trip. Guardrails (e.g., share_total_ctr ≥ -30%) can trigger Kill before stat-sig.

---

## Pattern 4: Stripe (or any payment) outages will silently kill you

**Symptom**: Premium clicks normal. Premium checkouts normal. Premium paid... 0.

**Root cause**: Webhook misconfigured / Cloud Run secret rotated / Stripe price ID expired. Your PostHog frontend events fire fine. But payments don't complete.

**Fix**: Track `Checkout → Paid Conversion` as a **system health KPI**, not a UX KPI. If it drops to 0%, your dashboard should scream — and the pipeline should refuse to ship UX changes until you debug payments.

**How funnel-optimize handles**: `checkout_paid_rate` can be P0 priority alongside `payment_completed_rate`. Both are guarded.

---

## Pattern 5: Single-agent AI has blind spots

**Symptom**: Claude keeps suggesting structural changes (Premium card placement). You wonder if there are other angles.

**Root cause**: LLMs have personality. Claude leans conservative + structural. Codex leans bold + UX-redesign. Gemini leans copy/framing. Single-agent loops circle.

**Fix**: Run all 3 in parallel. Layer 1 auto-scores. Layer 2 (AI PM judgment) picks the winner — sometimes flipping Layer 1 ranking based on strategic fit.

**How funnel-optimize handles**: That's the whole Triple-Agent design. If Codex/Gemini CLIs aren't installed, you fall back to Claude-only — but Layer 2 is stricter on single-agent picks.

---

## Pattern 6: "It worked once" doesn't mean "it works"

**Symptom**: Experiment ships with +521% CTR. You revert it 12 days later when revenue doesn't follow.

**Root cause**: Lift on a proxy metric ≠ lift on the goal metric. Gaming the proxy is easy.

**Fix**: After Ship, **monitor for 2 weeks** before declaring victory. Check the P0 KPI specifically.

**How funnel-optimize handles**: Phase 5 includes "Ship verification window" — patterns.json records both Ship and Revert.

---

## Cumulative learning (your patterns.json)

Every Kill or Ship updates `patterns.json` with:
- The KPI tried
- The variant approach (structural/copy/timing/etc.)
- The outcome
- The lesson

Next week's Triple-Agent prompt automatically includes:
> "Past failures: <list>. Don't propose these patterns again unless materially different."

This compounds over time. After 8 weeks, your `patterns.json` is a personalized playbook.
