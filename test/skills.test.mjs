import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillFrontmatter, deriveDomain, scanSkillDirs } from '../lib/skills.mjs';

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
