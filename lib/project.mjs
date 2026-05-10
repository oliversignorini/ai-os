import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';

// Per-project data lives under data/projects/<short-hash>/. The hash is taken
// from the absolute project path so renames/moves create a fresh workspace
// rather than silently mixing histories. 12 hex chars = 48 bits, plenty for
// any plausible number of projects on one machine.
export function projectDataDir(dataRoot, projectDir) {
  const abs = resolve(projectDir);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 12);
  return join(dataRoot, 'projects', hash);
}

export async function ensureProjectDataDir(dataRoot, projectDir) {
  const dir = projectDataDir(dataRoot, projectDir);
  await mkdir(join(dir, 'transcripts'), { recursive: true });
  return dir;
}

export async function readConfig(dataRoot) {
  const path = join(dataRoot, 'config.json');
  try {
    const text = await readFile(path, 'utf8');
    const cfg = JSON.parse(text);
    return {
      lastProject: cfg.lastProject || null,
      claudePath: cfg.claudePath || null,
      recentProjects: Array.isArray(cfg.recentProjects) ? cfg.recentProjects : [],
    };
  } catch {
    return { lastProject: null, claudePath: null, recentProjects: [] };
  }
}

export async function writeConfig(dataRoot, patch) {
  const cur = await readConfig(dataRoot);
  const next = { ...cur, ...patch };
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, 'config.json'), JSON.stringify(next, null, 2));
  return next;
}

// Add to recents in MRU order, dedup by absolute path, cap at 10.
export function pushRecent(recents, projectDir) {
  const abs = resolve(projectDir);
  const filtered = (recents || []).filter(p => resolve(p) !== abs);
  return [abs, ...filtered].slice(0, 10);
}

// One-shot migration: moves the legacy flat data/runs.jsonl + data/transcripts/
// into the per-project bucket. Only runs if the old files exist AND the target
// is empty, so it's safe to call on every boot.
export async function migrateLegacyData(dataRoot, targetProjectDataDir) {
  const legacyRuns = join(dataRoot, 'runs.jsonl');
  const legacyTranscripts = join(dataRoot, 'transcripts');
  const targetRuns = join(targetProjectDataDir, 'runs.jsonl');
  const targetTranscripts = join(targetProjectDataDir, 'transcripts');

  let migrated = false;
  if (existsSync(legacyRuns) && !existsSync(targetRuns)) {
    await rename(legacyRuns, targetRuns);
    migrated = true;
  }
  if (existsSync(legacyTranscripts)) {
    try {
      const targetEmpty = !existsSync(targetTranscripts) || (await readdir(targetTranscripts)).length === 0;
      if (targetEmpty) {
        // Replace the auto-created empty target with the legacy one
        if (existsSync(targetTranscripts)) {
          const { rmdir } = await import('node:fs/promises');
          await rmdir(targetTranscripts).catch(() => {});
        }
        await rename(legacyTranscripts, targetTranscripts);
        migrated = true;
      }
    } catch {}
  }
  return migrated;
}

export function describeProject(projectDir) {
  return { path: projectDir, name: basename(projectDir), exists: existsSync(projectDir) };
}
