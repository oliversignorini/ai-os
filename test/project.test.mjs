import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import {
  projectDataDir,
  ensureProjectDataDir,
  readConfig,
  writeConfig,
  pushRecent,
  describeProject,
  migrateLegacyData,
} from '../lib/project.mjs';
import { createApp } from '../server.mjs';

test('projectDataDir hashes path stably', () => {
  const d = projectDataDir('/tmp/data', '/some/project');
  const d2 = projectDataDir('/tmp/data', '/some/project');
  assert.equal(d, d2);
  assert.match(d, /projects[\\/][a-f0-9]{12}$/);
  assert.notEqual(projectDataDir('/tmp/data', '/other/project'), d);
});

test('ensureProjectDataDir creates transcripts subdir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proj-data-'));
  const dir = await ensureProjectDataDir(root, '/some/project');
  assert.ok(existsSync(join(dir, 'transcripts')));
  await rm(root, { recursive: true, force: true });
});

test('pushRecent dedups and caps at 10 in MRU order', () => {
  let r = [];
  r = pushRecent(r, '/a');
  r = pushRecent(r, '/b');
  r = pushRecent(r, '/a'); // bump to front
  assert.equal(r[0], resolve('/a'));
  assert.equal(r[1], resolve('/b'));
  assert.equal(r.length, 2);
  for (let i = 0; i < 15; i++) r = pushRecent(r, `/p${i}`);
  assert.equal(r.length, 10);
  assert.equal(r[0], resolve('/p14'));
});

test('readConfig returns empty defaults when file missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfg-'));
  const cfg = await readConfig(root);
  assert.deepEqual(cfg, { lastProject: null, claudePath: null, recentProjects: [] });
  await rm(root, { recursive: true, force: true });
});

test('writeConfig + readConfig roundtrip merges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfg-rt-'));
  await writeConfig(root, { lastProject: '/x' });
  await writeConfig(root, { claudePath: '/y' });
  const cfg = await readConfig(root);
  assert.equal(cfg.lastProject, '/x');
  assert.equal(cfg.claudePath, '/y');
  await rm(root, { recursive: true, force: true });
});

test('describeProject returns name + exists flag', () => {
  const d = describeProject(process.cwd());
  assert.equal(d.name, basename(process.cwd()));
  assert.equal(d.exists, true);
});

test('GET /api/project returns current + recents', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'p1-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'd1-'));
  const dataDir = await ensureProjectDataDir(dataRoot, projectDir);
  await writeConfig(dataRoot, { recentProjects: [projectDir, '/some/other'] });

  const app = await createApp({
    projectDir, dataDir, dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
  });
  await new Promise((res) => app.server.listen(0, res));
  const { port } = app.server.address();
  const r = await fetch(`http://localhost:${port}/api/project`);
  const body = await r.json();
  assert.equal(body.current.path, projectDir);
  assert.ok(body.recents.find(p => p.path === projectDir));
  await new Promise((res) => app.server.close(res));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('POST /api/project switches project, persists config, isolates dataDir', async () => {
  const projectA = await mkdtemp(join(tmpdir(), 'pA-'));
  const projectB = await mkdtemp(join(tmpdir(), 'pB-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dr-'));
  const dataDirA = await ensureProjectDataDir(dataRoot, projectA);

  // Skill present in B but not A — proves the skill scanner re-targets after switch
  await mkdir(join(projectB, '.claude', 'skills', 'bskill'), { recursive: true });
  await writeFile(
    join(projectB, '.claude', 'skills', 'bskill', 'SKILL.md'),
    '---\nname: b-only\ndescription: only in B\n---\n'
  );

  const app = await createApp({
    projectDir: projectA, dataDir: dataDirA, dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
  });
  await new Promise((res) => app.server.listen(0, res));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  // Pre-switch: no b-only skill
  let skills = await (await fetch(`${base}/api/skills`)).json();
  assert.ok(!skills.find(s => s.name === 'b-only'));

  // Switch
  const sw = await fetch(`${base}/api/project`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: projectB }),
  });
  assert.equal(sw.status, 200);
  const swBody = await sw.json();
  assert.equal(swBody.current.path, resolve(projectB));

  // Post-switch: b-only skill visible
  skills = await (await fetch(`${base}/api/skills`)).json();
  assert.ok(skills.find(s => s.name === 'b-only'), 'b-only should be visible after switch');

  // Config persisted
  const cfg = JSON.parse(await readFile(join(dataRoot, 'config.json'), 'utf8'));
  assert.equal(cfg.lastProject, resolve(projectB));
  assert.ok(cfg.recentProjects.includes(resolve(projectB)));

  await new Promise((res) => app.server.close(res));
  await rm(projectA, { recursive: true, force: true });
  await rm(projectB, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('migrateLegacyData moves legacy runs+transcripts into target on first boot', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'mig-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'pmig-'));
  // Seed legacy layout
  await writeFile(join(dataRoot, 'runs.jsonl'), '{"runId":"r-old"}\n');
  await mkdir(join(dataRoot, 'transcripts'), { recursive: true });
  await writeFile(join(dataRoot, 'transcripts', 'r-old.jsonl'), '{"type":"system"}\n');

  const target = await ensureProjectDataDir(dataRoot, projectDir);
  const did = await migrateLegacyData(dataRoot, target);
  assert.equal(did, true);
  assert.ok(existsSync(join(target, 'runs.jsonl')), 'runs.jsonl moved');
  assert.ok(existsSync(join(target, 'transcripts', 'r-old.jsonl')), 'transcripts moved');
  assert.ok(!existsSync(join(dataRoot, 'runs.jsonl')), 'legacy runs.jsonl removed');

  // Idempotent: second call no-ops
  const did2 = await migrateLegacyData(dataRoot, target);
  assert.equal(did2, false);
  await rm(dataRoot, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

test('POST /api/project rejects nonexistent path', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pX-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dX-'));
  const dataDir = await ensureProjectDataDir(dataRoot, projectDir);
  const app = await createApp({
    projectDir, dataDir, dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
  });
  await new Promise((res) => app.server.listen(0, res));
  const { port } = app.server.address();
  const r = await fetch(`http://localhost:${port}/api/project`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/this/does/not/exist/anywhere' }),
  });
  assert.equal(r.status, 400);
  await new Promise((res) => app.server.close(res));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});
