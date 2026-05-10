import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjectFiles } from '../lib/files.mjs';
import { createApp } from '../server.mjs';

test('listProjectFiles returns POSIX-style relative paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'files-'));
  await mkdir(join(root, 'src/lib'), { recursive: true });
  await writeFile(join(root, 'README.md'), '');
  await writeFile(join(root, 'src/lib/foo.mjs'), '');

  const all = await listProjectFiles(root);
  assert.ok(all.includes('README.md'));
  assert.ok(all.includes('src/lib/foo.mjs'), 'paths use forward slashes regardless of OS');
  await rm(root, { recursive: true, force: true });
});

test('listProjectFiles skips noise dirs (node_modules, .git, dist, etc.)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'files-skip-'));
  await mkdir(join(root, 'node_modules/junk'), { recursive: true });
  await mkdir(join(root, '.git/objects'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'node_modules/junk/foo.js'), '');
  await writeFile(join(root, '.git/objects/abc'), '');
  await writeFile(join(root, 'dist/bundle.js'), '');
  await writeFile(join(root, 'src/keep.mjs'), '');

  const files = await listProjectFiles(root);
  assert.equal(files.length, 1);
  assert.equal(files[0], 'src/keep.mjs');
  await rm(root, { recursive: true, force: true });
});

test('listProjectFiles ranks basename matches above path-fragment matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'files-rank-'));
  await mkdir(join(root, 'deep/nested/config'), { recursive: true });
  await writeFile(join(root, 'config.json'), '');                    // exact basename
  await writeFile(join(root, 'deep/configish.mjs'), '');             // starts-with
  await writeFile(join(root, 'deep/nested/config/index.mjs'), '');   // path fragment

  const result = await listProjectFiles(root, { query: 'config' });
  assert.equal(result[0], 'config.json', 'exact basename match wins');
  // The other two should be present, in lower priority order
  assert.ok(result.includes('deep/configish.mjs'));
  assert.ok(result.includes('deep/nested/config/index.mjs'));
  await rm(root, { recursive: true, force: true });
});

test('listProjectFiles caps at maxResults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'files-cap-'));
  for (let i = 0; i < 20; i++) await writeFile(join(root, `f${i}.txt`), '');
  const result = await listProjectFiles(root, { maxResults: 5 });
  assert.equal(result.length, 5);
  await rm(root, { recursive: true, force: true });
});

test('listProjectFiles returns [] for missing dir without throwing', async () => {
  const result = await listProjectFiles('/this/does/not/exist/anywhere');
  assert.deepEqual(result, []);
});

test('GET /api/files returns project files filtered by q', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pfiles-'));
  await mkdir(join(projectDir, 'src'), { recursive: true });
  await writeFile(join(projectDir, 'package.json'), '{}');
  await writeFile(join(projectDir, 'src/index.mjs'), '');

  const dataRoot = await mkdtemp(join(tmpdir(), 'dfiles-'));
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: () => { throw new Error('unused'); },
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  const all = await (await fetch(`${base}/api/files`)).json();
  assert.ok(all.includes('package.json'));
  assert.ok(all.includes('src/index.mjs'));

  const filtered = await (await fetch(`${base}/api/files?q=package`)).json();
  assert.equal(filtered[0], 'package.json');

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});
