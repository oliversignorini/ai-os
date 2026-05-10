import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

function runsJsonlPath(dataDir) { return join(dataDir, 'runs.jsonl'); }
function transcriptPath(dataDir, runId) { return join(dataDir, 'runs', `${runId}.jsonl`); }

async function ensureDir(file) {
  await mkdir(dirname(file), { recursive: true });
}

export async function appendRun(dataDir, record) {
  const path = runsJsonlPath(dataDir);
  await ensureDir(path);
  await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
}

export async function readRuns(dataDir, limit = 50) {
  let text;
  try {
    text = await readFile(runsJsonlPath(dataDir), 'utf8');
  } catch {
    return [];
  }
  const lines = text.trim().split('\n').filter(Boolean);
  const records = lines.map(l => JSON.parse(l)).reverse();
  return records.slice(0, limit);
}

export async function appendTranscriptEvent(dataDir, runId, event) {
  const path = transcriptPath(dataDir, runId);
  await ensureDir(path);
  await appendFile(path, JSON.stringify(event) + '\n', 'utf8');
}

export async function readTranscript(dataDir, runId) {
  let text;
  try {
    text = await readFile(transcriptPath(dataDir, runId), 'utf8');
  } catch {
    return [];
  }
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export async function lastRunAtBySkillId(dataDir) {
  const runs = await readRuns(dataDir, Number.MAX_SAFE_INTEGER);
  const map = {};
  for (const r of runs) {
    if (!r.skillId || !r.startedAt) continue;
    if (!map[r.skillId] || r.startedAt > map[r.skillId]) {
      map[r.skillId] = r.startedAt;
    }
  }
  return map;
}
