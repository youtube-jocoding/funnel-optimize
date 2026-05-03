import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// All tests will live here. We import from render-dashboard.mjs as it grows.
// This skeleton verifies node:test wiring works before any implementation.

test('node:test runner is wired up', () => {
  assert.equal(1 + 1, 2);
});
