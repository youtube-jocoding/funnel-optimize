import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { pValueTwoProp } from './render-dashboard.mjs';

test('pValueTwoProp returns null when sample is too small', () => {
  // n < 30 per side → undersized
  assert.equal(pValueTwoProp(0, 10, 2, 10), null);
});

test('pValueTwoProp returns p ≈ 1 when proportions are identical', () => {
  const result = pValueTwoProp(50, 1000, 50, 1000);
  assert.ok(result !== null);
  assert.ok(result.p > 0.99, `p should be ≈ 1, got ${result.p}`);
  assert.ok(Math.abs(result.z) < 0.01, `z should be ≈ 0, got ${result.z}`);
});

test('pValueTwoProp matches the animalface week-7 reported p ≈ 0.17', () => {
  // control 0/4631, test 2/4931 — case-study reports p=0.1682
  const result = pValueTwoProp(0, 4631, 2, 4931);
  assert.ok(result !== null);
  // Allow generous tolerance — different test variants give slightly different numbers.
  assert.ok(result.p > 0.10 && result.p < 0.30, `expected p≈0.17, got ${result.p}`);
});

test('pValueTwoProp returns null on zero totals', () => {
  assert.equal(pValueTwoProp(0, 0, 0, 0), null);
});
