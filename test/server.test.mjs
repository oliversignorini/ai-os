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
