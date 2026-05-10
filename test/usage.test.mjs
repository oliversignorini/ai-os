import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsage, extractPercents } from '../lib/usage.mjs';

test('extractPercents from common shape', () => {
  const cache = {
    fiveHourLimit: { percentUsed: 47 },
    weeklyLimit: { percentUsed: 23 },
  };
  assert.deepEqual(extractPercents(cache), { fiveHourPercentUsed: 47, weeklyPercentUsed: 23 });
});

test('extractPercents from alt nested shape', () => {
  const cache = {
    limits: {
      '5h': { percent_used: 47 },
      '7d': { percent_used: 23 },
    },
  };
  assert.deepEqual(extractPercents(cache), { fiveHourPercentUsed: 47, weeklyPercentUsed: 23 });
});

test('extractPercents returns null for unrecognized shape', () => {
  assert.equal(extractPercents({ random: 'thing' }), null);
});

test('readUsage returns null when file missing', async () => {
  const result = await readUsage('/nonexistent/path/stats-cache.json');
  assert.equal(result, null);
});

test('readUsage parses + extracts when file present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-test-'));
  const path = join(root, 'stats-cache.json');
  await writeFile(path, JSON.stringify({ fiveHourLimit: { percentUsed: 12 }, weeklyLimit: { percentUsed: 34 } }));
  const result = await readUsage(path);
  assert.deepEqual(result, { fiveHourPercentUsed: 12, weeklyPercentUsed: 34 });
  await rm(root, { recursive: true, force: true });
});

test('readUsage returns null on malformed JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-test-'));
  const path = join(root, 'stats-cache.json');
  await writeFile(path, 'not json');
  const result = await readUsage(path);
  assert.equal(result, null);
  await rm(root, { recursive: true, force: true });
});
