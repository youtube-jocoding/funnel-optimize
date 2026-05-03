#!/usr/bin/env node

/**
 * Shared utilities for funnel automation scripts.
 * Reuses patterns from posthog-analytics.mjs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '../..');

// ─── .env loader ─────────────────────────────────────────────────────────────

export function loadEnv() {
  const envPath = path.resolve(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

// ─── PostHog API ─────────────────────────────────────────────────────────────

export function createPostHogClient() {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
  let projectId = process.env.POSTHOG_PROJECT_ID || null;

  if (!apiKey) {
    throw new Error('POSTHOG_API_KEY is required');
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  async function apiGet(endpoint) {
    const res = await fetch(`${host}${endpoint}`, { headers });
    if (!res.ok) throw new Error(`GET ${endpoint} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  async function apiPost(endpoint, body) {
    const res = await fetch(`${host}${endpoint}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${endpoint} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  async function resolveProjectId() {
    if (projectId) return projectId;
    const data = await apiGet('/api/projects/');
    const projects = data.results || data;
    if (projects.length === 0) throw new Error('No projects found');
    projectId = String(projects[0].id);
    return projectId;
  }

  async function hogql(query, name = '') {
    const pid = await resolveProjectId();
    try {
      const data = await apiPost(`/api/projects/${pid}/query/`, {
        query: { kind: 'HogQLQuery', query },
        name: name || undefined,
      });
      return { columns: data.columns || [], results: data.results || [], types: data.types || [] };
    } catch (err) {
      console.error(`  Query failed [${name}]: ${err.message}`);
      return { columns: [], results: [], types: [] };
    }
  }

  async function hogqlBatch(queries, batchSize = 3) {
    const results = {};
    const entries = Object.entries(queries);
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(([key, { name, query }]) => hogql(query, name))
      );
      batch.forEach(([key], idx) => { results[key] = batchResults[idx]; });
      if (i + batchSize < entries.length) await new Promise(r => setTimeout(r, 500));
    }
    return results;
  }

  // PostHog Feature Flags API
  async function listFeatureFlags() {
    const pid = await resolveProjectId();
    const data = await apiGet(`/api/projects/${pid}/feature_flags/?limit=100`);
    return data.results || [];
  }

  async function createFeatureFlag(flagData) {
    const pid = await resolveProjectId();
    return apiPost(`/api/projects/${pid}/feature_flags/`, flagData);
  }

  async function updateFeatureFlag(flagId, flagData) {
    const pid = await resolveProjectId();
    const res = await fetch(`${host}/api/projects/${pid}/feature_flags/${flagId}/`, {
      method: 'PATCH', headers, body: JSON.stringify(flagData),
    });
    if (!res.ok) throw new Error(`PATCH feature_flags/${flagId} failed: ${await res.text()}`);
    return res.json();
  }

  async function listExperiments() {
    const pid = await resolveProjectId();
    const data = await apiGet(`/api/projects/${pid}/experiments/?limit=100`);
    return data.results || [];
  }

  async function getExperimentResults(experimentId) {
    const pid = await resolveProjectId();
    return apiGet(`/api/projects/${pid}/experiments/${experimentId}/results/`);
  }

  return {
    hogql, hogqlBatch, resolveProjectId,
    listFeatureFlags, createFeatureFlag, updateFeatureFlag,
    listExperiments, getExperimentResults,
    apiGet, apiPost,
  };
}

// ─── Config ──────────────────────────────────────────────────────────────────

export function loadConfig() {
  const configPath = path.resolve(ROOT_DIR, 'funnel-config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

export async function exec(cmd) {
  const { execSync } = await import('child_process');
  return execSync(cmd, { cwd: ROOT_DIR, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim();
}

export async function getGitChanges(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const log = await exec(`git log --since="${since}" --oneline --no-merges`);
  const diffStat = await exec(`git log --since="${since}" --stat --no-merges`);
  const changedFiles = await exec(`git log --since="${since}" --name-only --no-merges --pretty=format:""`);
  return { log, diffStat, changedFiles: [...new Set(changedFiles.split('\n').filter(Boolean))] };
}

// ─── State management ────────────────────────────────────────────────────────

const STATE_DIR = path.resolve(ROOT_DIR, '.funnel-state');

export function loadState() {
  const statePath = path.resolve(STATE_DIR, 'state.json');
  if (!fs.existsSync(statePath)) {
    return { active_experiment: null, history: [], last_run: null };
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

export function saveState(state) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const statePath = path.resolve(STATE_DIR, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ─── Security Scanner ────────────────────────────────────────────────────────
// Checks AI-generated code for dangerous patterns before applying

export function scanForSecurityIssues(code, allowedDomains = ['localhost', 'posthog.com']) {
  const issues = [];
  if (/\beval\s*\(/.test(code)) issues.push('eval() call detected');
  if (/\bnew\s+Function\s*\(/.test(code)) issues.push('new Function() detected');
  const allowedRegex = new RegExp(allowedDomains.map(d => d.replace(/\./g, '\\.')).join('|'));
  const fetchMatch = code.match(/fetch\s*\(\s*['"`]([^'"`]+)/g);
  if (fetchMatch) {
    for (const m of fetchMatch) {
      const url = m.replace(/fetch\s*\(\s*['"`]/, '');
      if (/^https?:\/\//.test(url) && !allowedRegex.test(url)) {
        issues.push(`fetch to unknown domain: ${url}`);
      }
    }
  }
  if (/document\.cookie/.test(code)) issues.push('document.cookie access');
  if (/localStorage\.(get|set|remove)Item\s*\(\s*['"`](token|auth|session|key|secret)/i.test(code)) {
    issues.push('localStorage access to auth-related key');
  }
  if (/\.innerHTML\s*=/.test(code)) issues.push('innerHTML assignment (XSS risk)');
  if (/dangerouslySetInnerHTML/.test(code)) issues.push('dangerouslySetInnerHTML (XSS risk)');
  if (/stripe.*publishableKey|sk_live|sk_test|price_/i.test(code)) issues.push('Stripe key/price modification');
  const locationMatch = code.match(/window\.location\s*(?:\.href)?\s*=\s*['"`]([^'"`]+)/g);
  if (locationMatch) {
    for (const m of locationMatch) {
      const url = m.replace(/window\.location\s*(?:\.href)?\s*=\s*['"`]/, '');
      if (/^https?:\/\//.test(url) && !allowedRegex.test(url)) {
        issues.push(`Redirect to external domain: ${url}`);
      }
    }
  }
  if (/<script[\s>]/i.test(code)) issues.push('<script> tag injection');
  return issues;
}

// ─── Guardrail Validation ────────────────────────────────────────────────────

export function validateGuardrails(plan, config) {
  const violations = [];
  const guardrails = config.guardrails;
  const planText = JSON.stringify(plan).toLowerCase();

  if (guardrails.no_fake_urgency) {
    const patterns = [
      /countdown/i, /setinterval.*timer/i, /limited\s+offer/i,
      /expires?\s+in/i, /hurry/i, /only\s+\d+\s*(left|remaining)/i,
      /last\s+chance/i, /act\s+(now|fast)/i, /don'?t\s+miss/i,
    ];
    for (const p of patterns) {
      if (p.test(planText)) violations.push(`Fake urgency: ${p.source}`);
    }
  }

  if (guardrails.no_fake_social_proof) {
    const patterns = [
      /people\s+are\s+viewing/i, /others?\s+bought/i,
      /recently\s+purchased/i, /\d+\s+people\s+(are|have)\s/i,
    ];
    for (const p of patterns) {
      if (p.test(planText)) violations.push(`Fake social proof: ${p.source}`);
    }
  }

  if (plan.code_changes && guardrails.allowed_files) {
    for (const change of plan.code_changes) {
      const isAllowed = guardrails.allowed_files.some(pattern => {
        if (pattern.includes('*')) {
          // glob to regex: ** = .+, * = [^/]+
          const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*\*/g, '.+').replace(/\*/g, '[^/]+') + '$');
          return regex.test(change.file);
        }
        return pattern === change.file;
      });
      if (!isAllowed) {
        violations.push(`File not allowed: ${change.file}`);
      }
    }
  }

  if (plan.code_changes && plan.code_changes.length > (guardrails.max_code_changes || 5)) {
    violations.push(`Too many changes: ${plan.code_changes.length}`);
  }

  for (const change of plan.code_changes || []) {
    if (change.new_code && /return\s*\(\s*<>\s*(const|let|var)\s/.test(change.new_code)) {
      violations.push(`JS declaration inside JSX fragment in ${change.file}`);
    }
  }

  return violations;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

export function formatDate(date = new Date()) {
  return date.toISOString().split('T')[0];
}

export function daysAgo(days) {
  return formatDate(new Date(Date.now() - days * 86400000));
}
