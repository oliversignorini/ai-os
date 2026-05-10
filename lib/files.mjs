import { readdir } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';

// Standard junk we never want in autocomplete results.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.turbo',
  'dist', 'build', 'out', 'coverage', '.cache', '.parcel-cache',
  '.vercel', '.netlify', '.idea', '.vscode',
  // Heavy data-ish dirs that shouldn't show up in mention autocomplete
  'data', '.playwright-mcp', '.remember',
]);

// Cap depth + total results so a `find` on the home dir doesn't melt the server.
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_RESULTS = 200;

// Walk a project directory and return relative file paths (POSIX-style for
// consistency across OSes). Filters by query case-insensitively if given.
export async function listProjectFiles(projectDir, { query = '', maxDepth = DEFAULT_MAX_DEPTH, maxResults = DEFAULT_MAX_RESULTS } = {}) {
  const results = [];
  const q = query.trim().toLowerCase();

  async function walk(dir, depth) {
    if (depth > maxDepth || results.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const ent of entries) {
      if (results.length >= maxResults) return;
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.') && !['.gitignore', '.env.example'].includes(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        const rel = relative(projectDir, full).split(sep).join(posix.sep);
        if (!q || rel.toLowerCase().includes(q)) {
          results.push(rel);
        }
      }
    }
  }

  await walk(projectDir, 0);
  // Rank: shorter paths first (root files before deeply-nested), then alpha.
  // Within ranking, exact filename match scores highest.
  return results
    .map(p => ({
      path: p,
      score: rankPath(p, q),
    }))
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, maxResults)
    .map(r => r.path);
}

function rankPath(path, query) {
  if (!query) return 0;
  const lower = path.toLowerCase();
  const basename = lower.split('/').pop();
  // Exact basename match is best
  if (basename === query) return 100;
  // Basename starts with query
  if (basename.startsWith(query)) return 50;
  // Basename contains query
  if (basename.includes(query)) return 25;
  // Path starts with query (e.g. "lib/" matches lib/anything)
  if (lower.startsWith(query)) return 15;
  // Path contains query somewhere
  return 1;
}
