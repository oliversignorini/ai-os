import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { vaultChanges, parseGitLogOutput } from '../lib/vault-changes.mjs';

test('parseGitLogOutput parses status + path lines', () => {
  const out = 'M\tfoo.md\nA\tbar.md\nD\tbaz.md\n';
  assert.deepEqual(parseGitLogOutput(out), [
    { status: 'M', path: 'foo.md' },
    { status: 'A', path: 'bar.md' },
    { status: 'D', path: 'baz.md' },
  ]);
});

test('parseGitLogOutput skips empty + commit-pretty lines', () => {
  const out = '\n\nM\tfoo.md\n\n';
  assert.deepEqual(parseGitLogOutput(out), [{ status: 'M', path: 'foo.md' }]);
});

test('vaultChanges returns [] for non-git directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vc-test-'));
  const result = await vaultChanges(root);
  assert.deepEqual(result, []);
  await rm(root, { recursive: true, force: true });
});

test('vaultChanges returns recent changes from real git repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vc-test-'));
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email t@t.t && git config user.name t', { cwd: root, stdio: 'ignore', shell: true });
  await writeFile(join(root, 'foo.md'), 'hello\n');
  execSync('git add foo.md && git commit -m init', { cwd: root, stdio: 'ignore', shell: true });
  await writeFile(join(root, 'foo.md'), 'hello world\n');
  execSync('git add foo.md && git commit -m update', { cwd: root, stdio: 'ignore', shell: true });

  const changes = await vaultChanges(root);
  assert.ok(changes.some(c => c.path === 'foo.md' && (c.status === 'M' || c.status === 'A')));
  await rm(root, { recursive: true, force: true });
});
