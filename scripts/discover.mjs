#!/usr/bin/env node

/**
 * Discover mode: 새 사용자가 처음 funnel-optimize를 설치한 후 실행.
 *
 * Phase D-1: 프로젝트 분석 (framework / 결제 라이브러리 / 활성 컴포넌트 추출)
 * Phase D-2: PostHog 이벤트 카탈로그 dump
 * Phase D-3: KPI 인터뷰 (Claude Code가 사용자에게 질문)
 * Phase D-4: funnel-config.json 자동 생성 + 첫 dry-run
 *
 * Usage:
 *   node scripts/discover.mjs              # full discovery
 *   node scripts/discover.mjs --phase D-1  # specific phase only
 *   node scripts/discover.mjs --dry-run    # don't write config
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { loadEnv, createPostHogClient, ROOT_DIR } from './lib.mjs';

loadEnv();

const args = process.argv.slice(2);
let PHASE = 'all';
let DRY_RUN = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--phase' && args[i + 1]) { PHASE = args[i + 1]; i++; }
  if (args[i] === '--dry-run') DRY_RUN = true;
}

// ─── Backend payment library detection ───────────────────────────────────────

/**
 * Scan backend source directories and env template files for payment SDK usage.
 * Returns an array of detected provider names (e.g. ['stripe', 'toss']).
 */
function detectBackendPaymentLibraries(rootDir) {
  const detected = new Set();

  // Payment patterns per provider: { name -> [regex patterns] }
  const PAYMENT_PATTERNS = {
    stripe: [
      /stripe/i,
      /@stripe\//i,
      /stripe\.com/i,
      /STRIPE_/,
      /sk_live_/,
      /sk_test_/,
      /price_[A-Za-z0-9]/,
      /CheckoutSession/,
    ],
    iamport: [
      /iamport/i,
      /IAMPORT_/,
    ],
    toss: [
      /tosspayments/i,
      /toss-payments/i,
      /TOSS_/,
    ],
    portone: [
      /portone/i,
      /@portone\//i,
      /PORTONE_/,
    ],
    paypal: [
      /paypal/i,
      /@paypal\//i,
      /PAYPAL_/,
    ],
  };

  // 1. Scan backend source directories for payment SDK imports/references
  const BACKEND_DIRS = ['backend', 'server', 'api', 'cloudrun', 'functions'];
  const SOURCE_EXTENSIONS = /\.(js|ts|mjs|cjs|py|go|java|rb)$/;

  for (const dirName of BACKEND_DIRS) {
    const dirPath = path.resolve(rootDir, dirName);
    if (!fs.existsSync(dirPath)) continue;

    // Recursively collect source files (max depth 5 to avoid huge trees)
    const walkDir = (dir, depth = 0) => {
      if (depth > 5) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          walkDir(fullPath, depth + 1);
        } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
          let content;
          try { content = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }
          for (const [provider, patterns] of Object.entries(PAYMENT_PATTERNS)) {
            if (patterns.some(re => re.test(content))) {
              detected.add(provider);
            }
          }
        }
      }
    };
    walkDir(dirPath);
  }

  // 2. Check root-level Dockerfile / cloudrun.yaml for payment-related env vars
  const INFRA_FILES = ['Dockerfile', 'cloudrun.yaml', 'docker-compose.yml', 'docker-compose.yaml'];
  for (const fname of INFRA_FILES) {
    const fpath = path.resolve(rootDir, fname);
    if (!fs.existsSync(fpath)) continue;
    let content;
    try { content = fs.readFileSync(fpath, 'utf-8'); } catch { continue; }
    for (const [provider, patterns] of Object.entries(PAYMENT_PATTERNS)) {
      if (patterns.some(re => re.test(content))) {
        detected.add(provider);
      }
    }
  }

  // 3. Check .env.example / .env.template for payment env vars
  const ENV_TEMPLATE_FILES = ['.env.example', '.env.template', '.env.sample'];
  for (const fname of ENV_TEMPLATE_FILES) {
    const fpath = path.resolve(rootDir, fname);
    if (!fs.existsSync(fpath)) continue;
    let content;
    try { content = fs.readFileSync(fpath, 'utf-8'); } catch { continue; }
    for (const [provider, patterns] of Object.entries(PAYMENT_PATTERNS)) {
      if (patterns.some(re => re.test(content))) {
        detected.add(provider);
      }
    }
  }

  return [...detected];
}

// ─── Phase D-1: 프로젝트 분석 ────────────────────────────────────────────────

function analyzeProject() {
  console.log('\n[D-1] Analyzing project...');
  const result = {
    framework: 'unknown',
    payment_libraries: [],
    active_components: [],
    primary_language: 'javascript',
  };

  // package.json 읽기
  const pkgPath = path.resolve(ROOT_DIR, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) result.framework = 'next';
    else if (deps.astro) result.framework = 'astro';
    else if (deps.vue || deps.nuxt) result.framework = 'vue';
    else if (deps.react) result.framework = 'react';
    else if (deps.svelte || deps['@sveltejs/kit']) result.framework = 'svelte';

    if (deps.typescript) result.primary_language = 'typescript';

    // 결제 라이브러리 감지 (frontend deps)
    const paymentMap = {
      'stripe': 'stripe',
      '@stripe/stripe-js': 'stripe',
      'iamport-react-native': 'iamport',
      '@portone/browser-sdk': 'portone',
      'tosspayments': 'toss',
      'paypal': 'paypal',
    };
    for (const [dep, name] of Object.entries(paymentMap)) {
      if (deps[dep]) result.payment_libraries.push(name);
    }
  }

  // 결제 라이브러리 감지 (backend: source dirs + env templates + infra files)
  const backendPayments = detectBackendPaymentLibraries(ROOT_DIR);
  if (backendPayments.length > 0) {
    for (const lib of backendPayments) {
      if (!result.payment_libraries.includes(lib)) {
        result.payment_libraries.push(lib);
      }
    }
  }

  // 최근 30일 자주 변경된 컴포넌트 추출
  try {
    const log = execSync(
      'git log --since="30 days ago" --name-only --pretty=format:"" | grep -E "\\.(tsx|jsx|vue|svelte)$" | sort | uniq -c | sort -rn | head -10',
      { cwd: ROOT_DIR, encoding: 'utf-8', shell: '/bin/bash' }
    );
    result.active_components = log.split('\n')
      .filter(Boolean)
      .map(line => line.trim().split(/\s+/).slice(1).join(' '))
      .filter(Boolean);
  } catch (err) {
    // git log 실패 시 무시
  }

  console.log(`  Framework: ${result.framework}`);
  console.log(`  Language: ${result.primary_language}`);
  console.log(`  Payment libraries: ${result.payment_libraries.join(', ') || 'none detected'}`);
  console.log(`  Top changed components (30d):`);
  result.active_components.slice(0, 5).forEach(c => console.log(`    - ${c}`));

  return result;
}

// ─── Phase D-2: PostHog 이벤트 카탈로그 ──────────────────────────────────────

async function dumpEvents() {
  console.log('\n[D-2] Querying PostHog events (last 30 days)...');

  let posthog;
  try {
    posthog = createPostHogClient();
  } catch (err) {
    console.error('  ERROR: PostHog not configured.', err.message);
    console.error('  Set POSTHOG_API_KEY and POSTHOG_PROJECT_ID in .env, then retry.');
    return null;
  }

  const queries = {
    topByVolume: {
      name: 'top_events',
      query: `
        SELECT event, count() as cnt, uniq(distinct_id) as users
        FROM events
        WHERE timestamp >= now() - toIntervalDay(30)
        GROUP BY event
        ORDER BY cnt DESC
        LIMIT 30
      `,
    },
    revenueRelated: {
      name: 'revenue_related',
      query: `
        SELECT event, count() as cnt, uniq(distinct_id) as users
        FROM events
        WHERE timestamp >= now() - toIntervalDay(30)
          AND (event ILIKE '%paid%' OR event ILIKE '%purchase%' OR event ILIKE '%checkout%'
            OR event ILIKE '%subscribe%' OR event ILIKE '%upgrade%' OR event ILIKE '%complete%')
        GROUP BY event
        ORDER BY cnt DESC
        LIMIT 15
      `,
    },
    activationRelated: {
      name: 'activation_related',
      query: `
        SELECT event, count() as cnt, uniq(distinct_id) as users
        FROM events
        WHERE timestamp >= now() - toIntervalDay(30)
          AND (event ILIKE '%share%' OR event ILIKE '%signup%' OR event ILIKE '%onboard%'
            OR event ILIKE '%result%' OR event ILIKE '%complete%' OR event ILIKE '%save%')
        GROUP BY event
        ORDER BY cnt DESC
        LIMIT 15
      `,
    },
  };

  const results = await posthog.hogqlBatch(queries);

  const catalog = {
    top_events: (results.topByVolume.results || []).map(([event, cnt, users]) => ({ event, cnt, users })),
    revenue_related: (results.revenueRelated.results || []).map(([event, cnt, users]) => ({ event, cnt, users })),
    activation_related: (results.activationRelated.results || []).map(([event, cnt, users]) => ({ event, cnt, users })),
  };

  console.log(`  Top by volume: ${catalog.top_events.length} events`);
  catalog.top_events.slice(0, 10).forEach(e => console.log(`    ${e.event} (${e.cnt} events, ${e.users} users)`));
  console.log(`  Revenue-related: ${catalog.revenue_related.length} events`);
  catalog.revenue_related.slice(0, 5).forEach(e => console.log(`    ${e.event}`));
  console.log(`  Activation-related: ${catalog.activation_related.length} events`);
  catalog.activation_related.slice(0, 5).forEach(e => console.log(`    ${e.event}`));

  return catalog;
}

// ─── Phase D-3: KPI 인터뷰 prompt 생성 (Claude Code가 user에게 질문) ──────────

function generateInterviewPrompt(projectInfo, eventCatalog) {
  const topEvents = eventCatalog?.top_events?.slice(0, 15).map(e => `- ${e.event} (${e.cnt} events)`).join('\n  ') || '(no events)';
  const revenueEvents = eventCatalog?.revenue_related?.slice(0, 8).map(e => `- ${e.event}`).join('\n  ') || '(none detected)';
  const activationEvents = eventCatalog?.activation_related?.slice(0, 8).map(e => `- ${e.event}`).join('\n  ') || '(none detected)';

  return `# KPI Discovery Interview

You are helping a user set up funnel-optimize for their project.

## Project info (D-1)
- Framework: ${projectInfo.framework}
- Language: ${projectInfo.primary_language}
- Payment libraries: ${projectInfo.payment_libraries.join(', ') || 'none'}
- Top changed components (30d):
  ${projectInfo.active_components.slice(0, 5).map(c => `- ${c}`).join('\n  ')}

## PostHog event catalog (D-2)
### Top by volume:
  ${topEvents}

### Revenue-related candidates:
  ${revenueEvents}

### Activation-related candidates:
  ${activationEvents}

## Your task

Ask the user the following questions ONE AT A TIME (wait for each answer before asking next):

1. "What is your North Star metric? (e.g., weekly_paid_users, monthly_active_users, retention_rate)"
2. "Looking at the revenue-related events above, which event represents 'real revenue' (actual payment, NOT click/checkout-attempt)?"
3. "What is your 'result/value moment' event? (e.g., result_view, signup_complete — when user experiences the core value)"
4. "Which 1-3 KPIs do you want to optimize? For each: P0/P1/P2 priority + impression event + click event + target rate %"
5. "Approximate **DAU on the primary impression event** (the P0 KPI's impression_event). Used to size the experiment window so each cycle reaches significance. Round number is fine (e.g., 200, 1500, 18000)."
6. "Which files should AI agents be allowed to modify? (list 1-5 paths or globs)"
7. "What domains should be allowed for redirects/fetch? (e.g., yoursite.com, localhost — Stripe/PostHog auto-included)"

After collecting answers, generate funnel-config.json by calling:
\`\`\`bash
node scripts/discover.mjs --phase D-4 --interview-result '<JSON>'
\`\`\`

Where JSON has shape:
\`\`\`json
{
  "north_star": { "metric": "...", "target": "growth" },
  "real_revenue_event": "...",
  "value_moment_event": "...",
  "kpis": [
    { "kpi": "...", "metric_name": "...", "impression_event": "...", "click_events": [...], "target": 1.0, "priority": "P0" }
  ],
  "expected_dau": 1500,
  "min_detectable_lift_pct": 10,
  "allowed_files": ["..."],
  "allowed_domains": ["..."]
}
\`\`\`
`;
}

// ─── Phase D-4: funnel-config.json 자동 생성 ──────────────────────────────────

function writeConfig(projectInfo, eventCatalog, interviewResult) {
  const configPath = path.resolve(ROOT_DIR, 'funnel-config.json');

  if (fs.existsSync(configPath) && !DRY_RUN) {
    console.log(`  WARNING: funnel-config.json already exists.`);
    console.log(`  Backup created: funnel-config.json.bak`);
    fs.copyFileSync(configPath, configPath + '.bak');
  }

  const targets = (interviewResult.kpis || []).map(k => ({
    kpi: k.kpi,
    metric_name: k.metric_name,
    impression_event: k.impression_event,
    click_events: Array.isArray(k.click_events) ? k.click_events : [k.click_events],
    current: 0,
    target: k.target,
    priority: k.priority,
    direction: k.direction || 'higher',
  }));

  // DAU-driven experiment window: ceil(min_sample_size / DAU), clamped to [3, max_experiment_days].
  // If DAU not provided, fall back to a 7-day default (user can edit later).
  const minSample = 500;
  const maxDays = 28;
  const dau = Number(interviewResult.expected_dau) > 0 ? Number(interviewResult.expected_dau) : null;
  const experimentWindowDays = dau
    ? Math.max(3, Math.min(maxDays, Math.ceil(minSample / dau)))
    : 7;

  const config = {
    project: {
      name: path.basename(ROOT_DIR),
      framework: projectInfo.framework,
      north_star: interviewResult.north_star || { metric: 'unknown', target: 'growth' },
    },
    automation: {
      enabled: true,
      auto_merge: false,
      max_concurrent_experiments: 1,
      min_sample_size: minSample,
      significance_level: 0.05,
      min_early_decision_days: 0,
      experiment_window_days: experimentWindowDays,
      max_experiment_days: maxDays,
      expected_dau: dau,
      min_detectable_lift_pct: Number(interviewResult.min_detectable_lift_pct) > 0
        ? Number(interviewResult.min_detectable_lift_pct)
        : 10,
    },
    optimization_targets: targets.length ? targets : [
      {
        kpi: 'real_revenue_rate',
        metric_name: 'Real Revenue Rate (P0)',
        impression_event: interviewResult.value_moment_event || 'result_view',
        click_events: [interviewResult.real_revenue_event || 'payment_completed'],
        current: 0,
        target: 1.0,
        priority: 'P0',
        direction: 'higher',
      },
    ],
    funnel: {
      steps: [
        '$pageview',
        interviewResult.value_moment_event || 'result_view',
        interviewResult.real_revenue_event || 'payment_completed',
      ],
    },
    guardrails: {
      no_dark_patterns: true,
      no_fake_urgency: true,
      no_fake_social_proof: true,
      preserve_accessibility: true,
      max_code_changes: 5,
      allowed_files: interviewResult.allowed_files || projectInfo.active_components.slice(0, 3),
      allowed_domains_for_redirects: interviewResult.allowed_domains || ['localhost'],
    },
    multi_agent: {
      enabled: true,
      agents: ['claude', 'codex', 'gemini'],
      timeout_seconds: 1800,
      auto_select_threshold: 10,
      human_review_threshold: 5,
      fallback_agent: 'claude',
      preserve_losing_proposal: true,
      scoring_weights: {
        completeness: 15,
        schema_validity: 20,
        code_validity: 25,
        guardrail_compliance: 15,
        kpi_alignment: 10,
        novelty: 10,
        analysis_depth: 5,
      },
    },
    posthog: {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      feature_flag_prefix: 'funnel-exp-',
    },
  };

  if (DRY_RUN) {
    console.log('\n[DRY RUN] funnel-config.json contents:');
    console.log(JSON.stringify(config, null, 2));
  } else {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`  funnel-config.json written: ${configPath}`);
    if (dau) {
      console.log(`  experiment_window_days = ${experimentWindowDays} (ceil(${minSample}/${dau}), clamped to [3, ${maxDays}])`);
    } else {
      console.log(`  experiment_window_days = ${experimentWindowDays} (no DAU provided — using default; edit funnel-config.json once DAU is known)`);
    }
  }

  return config;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Funnel Optimize: Discovery Mode ===\n');

  const projectInfo = analyzeProject();

  if (PHASE === 'D-1') {
    fs.mkdirSync(path.resolve(ROOT_DIR, '.funnel-state'), { recursive: true });
    fs.writeFileSync(
      path.resolve(ROOT_DIR, '.funnel-state/discover-d1.json'),
      JSON.stringify(projectInfo, null, 2)
    );
    console.log('\nD-1 saved to .funnel-state/discover-d1.json');
    return;
  }

  const eventCatalog = await dumpEvents();
  if (PHASE === 'D-2') {
    if (eventCatalog) {
      fs.mkdirSync(path.resolve(ROOT_DIR, '.funnel-state'), { recursive: true });
      fs.writeFileSync(
        path.resolve(ROOT_DIR, '.funnel-state/discover-d2.json'),
        JSON.stringify(eventCatalog, null, 2)
      );
      console.log('\nD-2 saved to .funnel-state/discover-d2.json');
    }
    return;
  }

  // D-3: 인터뷰 prompt 출력 (Claude Code가 사용자에게 질문하도록)
  if (PHASE === 'D-3' || PHASE === 'all') {
    const prompt = generateInterviewPrompt(projectInfo, eventCatalog);
    fs.mkdirSync(path.resolve(ROOT_DIR, '.funnel-state'), { recursive: true });
    fs.writeFileSync(
      path.resolve(ROOT_DIR, '.funnel-state/discover-d3-interview-prompt.md'),
      prompt
    );
    console.log('\n[D-3] Interview prompt saved to .funnel-state/discover-d3-interview-prompt.md');
    console.log('  Next: Claude Code should ask the user the questions above, then run:');
    console.log('  node scripts/discover.mjs --phase D-4 --interview-result \'<JSON>\'');
  }

  // D-4: config 생성 (interview-result 인자 필요)
  if (PHASE === 'D-4') {
    const irIdx = args.indexOf('--interview-result');
    if (irIdx === -1) {
      console.error('ERROR: --interview-result <JSON> required for D-4');
      process.exit(1);
    }
    let interviewResult;
    try {
      interviewResult = JSON.parse(args[irIdx + 1]);
    } catch (err) {
      console.error('ERROR: --interview-result must be valid JSON:', err.message);
      process.exit(1);
    }
    writeConfig(projectInfo, eventCatalog, interviewResult);
    console.log('\n[D-4] Config generation complete.');
    console.log('  Next: review funnel-config.json, then run:');
    console.log('  node scripts/collect-data.mjs   # uses experiment_window_days from config');
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
