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

export async function scanPluginsDir(rootDir) {
  // Recursively walk rootDir, find every SKILL.md, derive source from the
  // path segments BEFORE the `skills/` segment (which is the plugin's identity:
  // vendor/plugin/version).
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.name === 'SKILL.md') {
        found.push(full);
      }
    }
  }
  await walk(rootDir);

  const out = [];
  for (const skillPath of found) {
    let text;
    try {
      text = await readFile(skillPath, 'utf8');
    } catch {
      continue;
    }
    const { name, description } = parseSkillFrontmatter(text);

    // Path → segments (POSIX form), find LAST 'skills' segment as the boundary.
    const rel = skillPath.slice(rootDir.length).replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = rel.split('/');
    const skillsIdx = segments.lastIndexOf('skills');
    const pluginPath = skillsIdx > 0 ? segments.slice(0, skillsIdx).join('/') : segments[0] || 'unknown';
    // Skill name from frontmatter, fall back to the directory containing SKILL.md
    const skillName = name || segments[segments.length - 2] || 'unnamed';

    out.push({
      id: `plugin:${pluginPath}/${skillName}`,
      source: `plugin:${pluginPath}`,
      path: skillPath,
      name: skillName,
      description: description || '',
      domain: deriveDomain(skillName),
    });
  }
  return dedupePluginSkills(out);
}

// Plugin cache stores multiple versions side-by-side
// (<vendor>/<plugin>/<version>/skills/<skill>/SKILL.md). Group by
// (vendor, plugin, skillName) and keep the highest version. Entries whose
// source doesn't fit the 3-segment shape pass through unchanged but are
// still deduped against exact-id collisions.
export function dedupePluginSkills(skills) {
  const byKey = new Map();
  for (const s of skills) {
    const segs = s.source.replace(/^plugin:/, '').split('/');
    const key = segs.length === 3
      ? `${segs[0]}/${segs[1]}/${s.name}`
      : s.id;
    const version = segs.length === 3 ? segs[2] : '';
    const existing = byKey.get(key);
    if (!existing || compareVersions(version, existing.version) > 0) {
      byKey.set(key, { skill: s, version });
    }
  }
  return Array.from(byKey.values()).map(v => v.skill);
}

// Numeric-aware compare so "10.0.0" > "9.0.0". Falls back to string compare
// for non-numeric segments (e.g. "1.0.0-beta").
export function compareVersions(a, b) {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? '0';
    const sb = pb[i] ?? '0';
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
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
