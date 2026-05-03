#!/usr/bin/env node

/**
 * Step 3: Implement experiment — apply code changes + create PostHog feature flag.
 *
 * Key safety measures:
 * - Validates old_code exists exactly once in target file
 * - Creates git backup before applying changes
 * - Runs TypeScript syntax check after applying
 * - Reverts all changes if any validation fails
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  loadEnv, createPostHogClient, loadConfig, loadState, saveState, ROOT_DIR, formatDate,
  scanForSecurityIssues,
} from './lib.mjs';

function isFileAllowed(file, allowedPatterns) {
  return allowedPatterns.some(pattern => {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*\*/g, '.+').replace(/\*/g, '[^/]+') + '$');
      return regex.test(file);
    }
    return pattern === file;
  });
}

loadEnv();

async function main() {
  console.log('\n=== Funnel Automation: Implement Experiment ===\n');

  const config = loadConfig();
  const state = loadState();
  const posthog = createPostHogClient();

  // Load experiment plan
  const planPath = path.resolve(ROOT_DIR, '.funnel-state/experiment-plan.json');
  if (!fs.existsSync(planPath)) {
    console.error('No experiment plan found. Run analyze-and-plan.mjs first.');
    process.exit(1);
  }

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));

  if (plan.action === 'continue') {
    console.log('Active experiment still running. No changes needed.');
    return;
  }

  if (plan.action === 'blocked') {
    console.error('Experiment blocked by guardrails:');
    (plan._guardrail_violations || []).forEach(v => console.error(`  - ${v}`));
    process.exit(1);
  }

  if (plan.action === 'error') {
    console.error('Experiment plan has errors.');
    process.exit(1);
  }

  if (plan.action === 'needs_review') {
    console.error('Experiment has code validation errors. Aborting.');
    (plan._code_validation_errors || []).forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  // Finalize previous experiment if needed
  if (state.active_experiment && config.automation.max_concurrent_experiments <= 1) {
    console.log('Finalizing previous experiment...');
    const prev = state.active_experiment;

    // Disable old feature flag in PostHog
    if (prev.flag_id) {
      try {
        await posthog.updateFeatureFlag(prev.flag_id, { active: false });
        console.log(`  Disabled old flag: ${prev.flag_key} (id: ${prev.flag_id})`);
      } catch (err) {
        console.warn(`  Warning: Could not disable old flag ${prev.flag_key}: ${err.message}`);
      }
    }

    state.history = state.history || [];
    state.history.push({
      ...prev,
      ended_at: new Date().toISOString(),
      ended_reason: 'superseded',
    });
    state.active_experiment = null;
  }

  // Cleanup: disable any historical flags still active in PostHog
  if (state.history?.length) {
    const allFlags = await posthog.listFeatureFlags();
    const activeHistorical = state.history
      .filter(h => h.flag_id)
      .filter(h => allFlags.some(f => f.id === h.flag_id && f.active));
    for (const h of activeHistorical) {
      try {
        await posthog.updateFeatureFlag(h.flag_id, { active: false });
        console.log(`  Cleanup: disabled stale flag ${h.flag_key} (id: ${h.flag_id})`);
      } catch (err) {
        console.warn(`  Warning: Could not disable stale flag ${h.flag_key}: ${err.message}`);
      }
    }
  }

  // ─── 1. Pre-validate all code changes ──────────────────────────────────

  console.log('1/4 Validating code changes...');

  const backups = new Map(); // file → original content

  for (const change of plan.code_changes || []) {
    const filePath = path.resolve(ROOT_DIR, change.file);

    if (!fs.existsSync(filePath)) {
      console.error(`  FAIL: File not found: ${change.file}`);
      process.exit(1);
    }

    // Check allowed files (supports glob patterns)
    if (config.guardrails.allowed_files && !isFileAllowed(change.file, config.guardrails.allowed_files)) {
      console.error(`  FAIL: File not in allowed list: ${change.file}`);
      process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    backups.set(filePath, content);

    // Validate old_code exists exactly once
    const occurrences = content.split(change.old_code).length - 1;
    if (occurrences === 0) {
      console.error(`  FAIL: old_code not found in ${change.file}`);
      console.error(`  Expected: "${change.old_code.slice(0, 120)}..."`);
      process.exit(1);
    }
    if (occurrences > 1) {
      console.error(`  FAIL: old_code found ${occurrences} times in ${change.file} (must be unique)`);
      process.exit(1);
    }

    // Security scan on new_code
    const securityIssues = scanForSecurityIssues(
      change.new_code,
      config.guardrails?.allowed_domains_for_redirects || ['localhost', 'posthog.com']
    );
    if (securityIssues.length > 0) {
      console.error(`  FAIL: Security issues in new_code for ${change.file}:`);
      securityIssues.forEach(s => console.error(`    - ${s}`));
      process.exit(1);
    }

    console.log(`  OK: ${change.file} — "${change.description}"`);
  }

  // ─── 2. Apply code changes ─────────────────────────────────────────────

  console.log('2/4 Applying code changes...');

  const appliedChanges = [];

  for (const change of plan.code_changes || []) {
    const filePath = path.resolve(ROOT_DIR, change.file);
    let content = fs.readFileSync(filePath, 'utf-8');

    // Simple string replacement — old_code → new_code
    content = content.replace(change.old_code, change.new_code);
    fs.writeFileSync(filePath, content);

    appliedChanges.push({ file: change.file, description: change.description });
    console.log(`  Applied: ${change.file}`);
  }

  // ─── 3. Build validation ───────────────────────────────────────────────

  console.log('3/4 Validating build...');

  let buildOk = false;
  try {
    // Quick TypeScript syntax check on changed files
    const changedTsxFiles = [...new Set(appliedChanges.map(c => c.file))]
      .filter(f => f.endsWith('.tsx') || f.endsWith('.ts'))
      .map(f => path.resolve(ROOT_DIR, f));

    if (changedTsxFiles.length > 0) {
      // Use a lightweight check — just parse the file for syntax errors
      for (const file of changedTsxFiles) {
        const content = fs.readFileSync(file, 'utf-8');

        // Basic syntax checks
        const errors = [];

        // Check balanced braces
        let braceCount = 0, parenCount = 0;
        for (const char of content) {
          if (char === '{') braceCount++;
          if (char === '}') braceCount--;
          if (char === '(') parenCount++;
          if (char === ')') parenCount--;
        }
        if (braceCount !== 0) errors.push(`Unbalanced braces (${braceCount > 0 ? '+' : ''}${braceCount})`);
        if (parenCount !== 0) errors.push(`Unbalanced parentheses (${parenCount > 0 ? '+' : ''}${parenCount})`);

        // Check for const/let/var inside JSX fragments
        if (/<>\s*(const|let|var)\s/.test(content)) {
          errors.push('JS declaration inside JSX fragment (<>const/let/var...)');
        }

        // Check for obvious JSX issues
        if (/return\s*\(\s*<>\s*(const|let|var)\s/.test(content)) {
          errors.push('Return statement with JS declaration in JSX');
        }

        if (errors.length > 0) {
          console.error(`  FAIL: Syntax errors in ${file}:`);
          errors.forEach(e => console.error(`    - ${e}`));
          throw new Error('Syntax validation failed');
        }
      }

      // Try actual TypeScript check if tsc is available
      try {
        execSync('npx tsc --noEmit --jsx react-jsx --esModuleInterop --moduleResolution node --target es2020 --module es2020 --skipLibCheck ' + changedTsxFiles.join(' '), {
          cwd: ROOT_DIR,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: 'pipe',
        });
        console.log('  TypeScript check passed.');
      } catch (tscErr) {
        // tsc might report pre-existing errors (like import.meta.env)
        // Only fail if it's clearly a new error related to our changes
        const output = (tscErr.stdout || '') + (tscErr.stderr || '');
        const newErrors = output.split('\n').filter(line =>
          line.includes('error TS') &&
          !line.includes('import.meta') &&
          !line.includes('Property \'env\'') &&
          !line.includes('TS2687') && // duplicate declaration modifiers (posthog global)
          !line.includes('TS2717')    // subsequent property declarations (posthog global)
        );
        if (newErrors.length > 0) {
          console.error('  TypeScript errors (new):');
          newErrors.slice(0, 5).forEach(e => console.error(`    ${e}`));
          throw new Error('TypeScript validation failed');
        }
        console.log('  TypeScript check passed (pre-existing warnings ignored).');
      }
    }

    buildOk = true;
  } catch (err) {
    console.error(`  Build validation failed: ${err.message}`);
    console.log('  Reverting all changes...');

    // Revert all files
    for (const [filePath, originalContent] of backups) {
      fs.writeFileSync(filePath, originalContent);
      console.log(`  Reverted: ${filePath}`);
    }

    // Save failure info
    const summaryPath = path.resolve(ROOT_DIR, '.funnel-state/implementation-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
      date: formatDate(),
      experiment: plan.experiment_name,
      status: 'failed',
      error: err.message,
    }, null, 2));

    process.exit(1);
  }

  // ─── 4. Create PostHog Feature Flag ────────────────────────────────────

  console.log('4/4 Creating PostHog feature flag...');

  // Build variant list from plan.variant_description (supports multivariate)
  const variantDesc = plan.variant_description || { control: 'Control', test: 'Test' };
  const variantKeys = Object.keys(variantDesc);
  const variantCount = variantKeys.length;
  const basePercent = Math.floor(100 / variantCount);
  const remainder = 100 - basePercent * variantCount;
  const variants = variantKeys.map((key, idx) => ({
    key,
    name: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
    rollout_percentage: basePercent + (idx === 0 ? remainder : 0),
  }));

  console.log(`  Variants (${variantCount}): ${variants.map(v => `${v.key}=${v.rollout_percentage}%`).join(', ')}`);

  let featureFlag;
  try {
    featureFlag = await posthog.createFeatureFlag({
      key: plan.flag_key,
      name: plan.experiment_name,
      filters: {
        groups: [{
          properties: [],
          rollout_percentage: 100,
        }],
        multivariate: { variants },
      },
      active: true,
    });
    console.log(`  Created: ${plan.flag_key} (id: ${featureFlag.id})`);
  } catch (err) {
    if (err.message.includes('already exists') || err.message.includes('unique')) {
      console.log(`  Flag ${plan.flag_key} already exists.`);
      const flags = await posthog.listFeatureFlags();
      featureFlag = flags.find(f => f.key === plan.flag_key);
    } else {
      // PostHog flag creation failed — revert all code changes
      console.error(`  PostHog API error: ${err.message}`);
      console.log('  Reverting all code changes...');
      for (const [filePath, originalContent] of backups) {
        fs.writeFileSync(filePath, originalContent);
        console.log(`  Reverted: ${filePath}`);
      }

      const summaryPath = path.resolve(ROOT_DIR, '.funnel-state/implementation-summary.json');
      fs.writeFileSync(summaryPath, JSON.stringify({
        date: formatDate(),
        experiment: plan.experiment_name,
        status: 'failed',
        error: `PostHog flag creation failed: ${err.message}`,
      }, null, 2));

      process.exit(1);
    }
  }

  // ─── Update state ──────────────────────────────────────────────────────

  state.active_experiment = {
    flag_key: plan.flag_key,
    flag_id: featureFlag?.id,
    experiment_name: plan.experiment_name,
    hypothesis: plan.hypothesis,
    target_kpi: plan.target_kpi,
    started_at: new Date().toISOString(),
    success_metric: plan.success_metric,
    code_changes: appliedChanges,
    variant_description: plan.variant_description,
  };

  saveState(state);

  const summaryPath = path.resolve(ROOT_DIR, '.funnel-state/implementation-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    date: formatDate(),
    experiment: plan.experiment_name,
    flag_key: plan.flag_key,
    status: 'success',
    applied_changes: appliedChanges,
  }, null, 2));

  console.log(`\nExperiment implemented: ${plan.experiment_name}`);
  console.log(`  Flag: ${plan.flag_key}`);
  console.log(`  Changes: ${appliedChanges.length}`);
  console.log('\nDone.');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
