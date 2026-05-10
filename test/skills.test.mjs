import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillFrontmatter, deriveDomain, scanSkillDirs, scanPluginsDir } from '../lib/skills.mjs';

test('parseSkillFrontmatter extracts name + description', () => {
  const md = '---\nname: research\ndescription: Research a topic\n---\n\n# Research\nbody...';
  assert.deepEqual(parseSkillFrontmatter(md), { name: 'research', description: 'Research a topic' });
});

test('parseSkillFrontmatter returns nulls when frontmatter missing', () => {
  assert.deepEqual(parseSkillFrontmatter('# No frontmatter here'), { name: null, description: null });
});

test('deriveDomain uses prefix before colon', () => {
  assert.equal(deriveDomain('vercel:deploy'), 'vercel');
  assert.equal(deriveDomain('notion:tasks:plan'), 'notion');
});

test('deriveDomain uses prefix before hyphen for kebab-case skills', () => {
  assert.equal(deriveDomain('gitnexus-cli'), 'gitnexus');
  assert.equal(deriveDomain('hw-brand-style'), 'hw');
});

test('deriveDomain falls back to uncategorized for single-word skills', () => {
  assert.equal(deriveDomain('research'), 'uncategorized');
  assert.equal(deriveDomain('ig'), 'uncategorized');
});

test('scanPluginsDir returns [] when root missing', async () => {
  const result = await scanPluginsDir('/this/does/not/exist');
  assert.deepEqual(result, []);
});

test('scanPluginsDir finds nested SKILL.md and derives plugin source from path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugins-test-'));
  // Mirror real shape: <vendor>/<plugin>/<version>/skills/<skill>/SKILL.md
  await mkdir(join(root, 'vendor-a/plug-x/1.0.0/skills/foo'), { recursive: true });
  await writeFile(
    join(root, 'vendor-a/plug-x/1.0.0/skills/foo/SKILL.md'),
    '---\nname: plug-x-foo\ndescription: A plug-x foo skill\n---\n'
  );
  // Also test the deeper nested shape (notion-style)
  await mkdir(join(root, 'vendor-a/plug-y/0.1.0/skills/plug-y/bar'), { recursive: true });
  await writeFile(
    join(root, 'vendor-a/plug-y/0.1.0/skills/plug-y/bar/SKILL.md'),
    '---\nname: plug-y-bar\ndescription: A nested skill\n---\n'
  );

  const result = await scanPluginsDir(root);
  assert.equal(result.length, 2);

  const foo = result.find(s => s.name === 'plug-x-foo');
  assert.ok(foo, 'plug-x-foo should be found');
  assert.equal(foo.source, 'plugin:vendor-a/plug-x/1.0.0');
  assert.match(foo.id, /^plugin:vendor-a\/plug-x\/1\.0\.0\/plug-x-foo$/);

  const bar = result.find(s => s.name === 'plug-y-bar');
  assert.ok(bar, 'plug-y-bar should be found');
  assert.equal(bar.source, 'plugin:vendor-a/plug-y/0.1.0');

  await rm(root, { recursive: true, force: true });
});

test('scanPluginsDir falls back to dirname when frontmatter missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugins-test-'));
  await mkdir(join(root, 'vendor/plug/1.0/skills/orphan'), { recursive: true });
  await writeFile(join(root, 'vendor/plug/1.0/skills/orphan/SKILL.md'), '# no frontmatter');
  const result = await scanPluginsDir(root);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'orphan');
  await rm(root, { recursive: true, force: true });
});

test('scanSkillDirs reads SKILL.md from each provided dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-test-'));
  await mkdir(join(root, 'a/foo'), { recursive: true });
  await mkdir(join(root, 'a/bar'), { recursive: true });
  await writeFile(join(root, 'a/foo/SKILL.md'), '---\nname: foo\ndescription: First\n---\n');
  await writeFile(join(root, 'a/bar/SKILL.md'), '---\nname: bar\ndescription: Second\n---\n');

  const skills = await scanSkillDirs([{ dir: join(root, 'a'), source: 'user' }]);
  assert.equal(skills.length, 2);
  const names = skills.map(s => s.name).sort();
  assert.deepEqual(names, ['bar', 'foo']);
  assert.equal(skills[0].source, 'user');
  assert.match(skills[0].id, /^user\//);
  assert.equal(skills[0].domain, 'uncategorized');

  await rm(root, { recursive: true, force: true });
});
