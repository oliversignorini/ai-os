import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export function parseSkillFrontmatter(text) {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { name: null, description: null };
  const block = m[1];
  const get = (key) => {
    const re = new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, 'm');
    const km = block.match(re);
    return km ? km[1].replace(/^["']|["']$/g, '') : null;
  };
  return { name: get('name'), description: get('description') };
}

export function deriveDomain(name) {
  if (!name) return 'uncategorized';
  const colonIdx = name.indexOf(':');
  if (colonIdx > 0) return name.slice(0, colonIdx);
  const hyphenIdx = name.indexOf('-');
  if (hyphenIdx > 0) return name.slice(0, hyphenIdx);
  return 'uncategorized';
}

export async function scanSkillDirs(sources) {
  const out = [];
  for (const { dir, source } of sources) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const skillPath = join(dir, ent.name, 'SKILL.md');
      let text;
      try {
        text = await readFile(skillPath, 'utf8');
      } catch {
        continue;
      }
      const { name, description } = parseSkillFrontmatter(text);
      const skillName = name || ent.name;
      out.push({
        id: `${source}/${skillName}`,
        source,
        path: skillPath,
        name: skillName,
        description: description || '',
        domain: deriveDomain(skillName),
      });
    }
  }
  return out;
}
