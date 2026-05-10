import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRun, readRuns, appendTranscriptEvent, readTranscript, lastRunAtBySkillId } from '../lib/runs.mjs';

test('appendRun + readRuns roundtrip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runs-test-'));
  await appendRun(root, { runId: 'r1', skillId: 'a/foo', prompt: '/foo', startedAt: '2026-01-01T00:00:00Z' });
  await appendRun(root, { runId: 'r2', skillId: 'a/bar', prompt: '/bar', startedAt: '2026-01-01T00:01:00Z', endedAt: '2026-01-01T00:01:30Z', exitCode: 0, status: 'ok' });

  const runs = await readRuns(root);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].runId, 'r2');
  assert.equal(runs[1].runId, 'r1');
  await rm(root, { recursive: true, force: true });
});

test('readRuns honors limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runs-test-'));
  for (let i = 0; i < 5; i++) {
    await appendRun(root, { runId: `r${i}`, skillId: 'a/foo', prompt: '/foo', startedAt: `2026-01-01T00:0${i}:00Z` });
  }
  const runs = await readRuns(root, 3);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map(r => r.runId), ['r4', 'r3', 'r2']);
  await rm(root, { recursive: true, force: true });
});

test('appendTranscriptEvent + readTranscript roundtrip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runs-test-'));
  await appendTranscriptEvent(root, 'r1', { type: 'system', subtype: 'init' });
  await appendTranscriptEvent(root, 'r1', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  const events = await readTranscript(root, 'r1');
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'system');
  assert.equal(events[1].message.content[0].text, 'hi');
  await rm(root, { recursive: true, force: true });
});

test('readTranscript returns [] when file missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runs-test-'));
  const events = await readTranscript(root, 'nonexistent');
  assert.deepEqual(events, []);
  await rm(root, { recursive: true, force: true });
});

test('lastRunAtBySkillId returns latest startedAt per skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runs-test-'));
  await appendRun(root, { runId: 'r1', skillId: 'a/foo', startedAt: '2026-01-01T00:00:00Z' });
  await appendRun(root, { runId: 'r2', skillId: 'a/foo', startedAt: '2026-01-02T00:00:00Z' });
  await appendRun(root, { runId: 'r3', skillId: 'a/bar', startedAt: '2026-01-01T12:00:00Z' });
  const map = await lastRunAtBySkillId(root);
  assert.equal(map['a/foo'], '2026-01-02T00:00:00Z');
  assert.equal(map['a/bar'], '2026-01-01T12:00:00Z');
  await rm(root, { recursive: true, force: true });
});
