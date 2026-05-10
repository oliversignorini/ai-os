import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createApp } from '../server.mjs';

function fakeChild() {
  const ee = new EventEmitter();
  ee.stdout = new Readable({ read() {} });
  ee.stderr = new Readable({ read() {} });
  ee.kill = (sig) => { setImmediate(() => ee.emit('exit', sig === 'SIGTERM' ? null : 0)); };
  return ee;
}

let app, address, projectDir;

before(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'agentic-server-test-'));
  await mkdir(join(projectDir, '.claude', 'skills', 'foo'), { recursive: true });
  await writeFile(
    join(projectDir, '.claude', 'skills', 'foo', 'SKILL.md'),
    '---\nname: project-foo\ndescription: Project foo skill\n---\n'
  );

  app = await createApp({
    projectDir,
    dataDir: await mkdtemp(join(tmpdir(), 'agentic-server-data-')),
    userSkillsDir: '/this/path/does/not/exist',
    pluginsDir: '/this/either',
    statsCachePath: '/nope',
    spawnRun: () => { throw new Error('not used in this test'); },
  });
  await new Promise((res) => app.server.listen(0, res));
  const { port } = app.server.address();
  address = `http://localhost:${port}`;
});

after(async () => {
  await new Promise((res) => app.server.close(res));
  await rm(projectDir, { recursive: true, force: true });
});

test('GET /api/skills returns scanned skills', async () => {
  const r = await fetch(`${address}/api/skills`);
  assert.equal(r.status, 200);
  const skills = await r.json();
  assert.ok(skills.find(s => s.name === 'project-foo'));
});

test('GET /api/runs returns []  when no runs', async () => {
  const r = await fetch(`${address}/api/runs`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('GET /api/vault-changes returns [] for non-git project', async () => {
  const r = await fetch(`${address}/api/vault-changes`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('GET /api/usage returns null for missing stats file', async () => {
  const r = await fetch(`${address}/api/usage`);
  assert.equal(r.status, 200);
  assert.equal(await r.json(), null);
});

test('GET /unknown serves index.html (SPA fallback)', async () => {
  const r = await fetch(`${address}/unknown-route`);
  assert.ok([200, 404].includes(r.status));
});

test('GET /api/runs/:id/stream forwards stdout as SSE', async () => {
  let pendingChild;
  await new Promise((res) => app.server.close(res));
  app = await createApp({
    projectDir,
    dataDir: await mkdtemp(join(tmpdir(), 'agentic-server-data-')),
    userSkillsDir: '/no',
    statsCachePath: '/no',
    spawnRun: () => { pendingChild = fakeChild(); return { child: pendingChild }; },
  });
  await new Promise((res) => app.server.listen(0, res));
  address = `http://localhost:${app.server.address().port}`;

  const startRes = await fetch(`${address}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skillId: 'project/project-foo', prompt: '/p' }),
  });
  const { runId } = await startRes.json();

  const streamRes = await fetch(`${address}/api/runs/${runId}/stream`);
  assert.equal(streamRes.status, 200);
  assert.equal(streamRes.headers.get('content-type'), 'text/event-stream');

  pendingChild.stdout.push('{"type":"system","subtype":"init"}\n');
  pendingChild.stdout.push('{"type":"result","subtype":"success","exit_code":0}\n');
  // Let the 'data' events flush through Node's stream machinery before exit
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  pendingChild.emit('exit', 0);

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  for (let i = 0; i < 5; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
    if (received.includes('"result"')) break;
  }
  assert.match(received, /data: \{"type":"system"/);
  assert.match(received, /data: \{"type":"result"/);
});

test('POST /api/runs/:id/cancel kills the child', async () => {
  let killedWith = null;
  await new Promise((res) => app.server.close(res));
  app = await createApp({
    projectDir,
    dataDir: await mkdtemp(join(tmpdir(), 'agentic-server-data-')),
    userSkillsDir: '/no',
    statsCachePath: '/no',
    spawnRun: () => {
      const ee = new EventEmitter();
      ee.stdout = new Readable({ read() {} });
      ee.stderr = new Readable({ read() {} });
      ee.kill = (sig) => { killedWith = sig; setImmediate(() => ee.emit('exit', null)); };
      return { child: ee };
    },
  });
  await new Promise((res) => app.server.listen(0, res));
  address = `http://localhost:${app.server.address().port}`;

  const startRes = await fetch(`${address}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skillId: 'project/project-foo', prompt: '/p' }),
  });
  const { runId } = await startRes.json();

  const cancelRes = await fetch(`${address}/api/runs/${runId}/cancel`, { method: 'POST' });
  assert.equal(cancelRes.status, 200);
  assert.deepEqual(await cancelRes.json(), { ok: true });
  assert.equal(killedWith, 'SIGTERM');
});

test('POST /api/run returns runId, child spawned via factory', async () => {
  const calls = [];
  await new Promise((res) => app.server.close(res));
  app = await createApp({
    projectDir,
    dataDir: await mkdtemp(join(tmpdir(), 'agentic-server-data-')),
    userSkillsDir: '/no',
    statsCachePath: '/no',
    spawnRun: (args) => { calls.push(args); return { child: fakeChild() }; },
  });
  await new Promise((res) => app.server.listen(0, res));
  const port = app.server.address().port;
  address = `http://localhost:${port}`;

  const r = await fetch(`${address}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skillId: 'project/project-foo', prompt: '/project-foo test' }),
  });
  assert.equal(r.status, 200);
  const { runId } = await r.json();
  assert.match(runId, /^r-/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, '/project-foo test');
});
