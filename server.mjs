import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { scanSkillDirs } from './lib/skills.mjs';
import { readRuns, lastRunAtBySkillId } from './lib/runs.mjs';
import { vaultChanges } from './lib/vault-changes.mjs';
import { readUsage } from './lib/usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res, publicDir) {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = join(publicDir, urlPath);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

export async function createApp(opts) {
  const {
    projectDir,
    dataDir,
    userSkillsDir = join(homedir(), '.claude', 'skills'),
    pluginsDir = join(homedir(), '.claude', 'plugins', 'cache'),
    statsCachePath = join(homedir(), '.claude', 'stats-cache.json'),
    publicDir = PUBLIC_DIR,
    spawnRun = defaultSpawnRun,
  } = opts;

  const skillSources = [
    { dir: userSkillsDir, source: 'user' },
    { dir: join(projectDir, '.claude', 'skills'), source: 'project' },
    // Plugin-installed skill scanning is a v1.x improvement (deep glob into pluginsDir).
  ];

  const activeRuns = new Map(); // runId → { child, stdoutBuf, status, ... }

  const server = createServer(async (req, res) => {
    try {
      const { method, url } = req;
      if (method === 'GET' && url === '/api/skills') {
        const skills = await scanSkillDirs(skillSources);
        const lastRunAt = await lastRunAtBySkillId(dataDir);
        return send(res, 200, skills.map(s => ({ ...s, lastRunAt: lastRunAt[s.id] || null })));
      }
      if (method === 'GET' && url.startsWith('/api/runs') && !url.match(/^\/api\/runs\/[^/]+/)) {
        const u = new URL(url, 'http://localhost');
        const limit = Number(u.searchParams.get('limit')) || 50;
        return send(res, 200, await readRuns(dataDir, limit));
      }
      if (method === 'GET' && url === '/api/vault-changes') {
        return send(res, 200, await vaultChanges(projectDir));
      }
      if (method === 'GET' && url === '/api/usage') {
        return send(res, 200, await readUsage(statsCachePath));
      }
      if (method === 'POST' && url === '/api/run') {
        const body = await readBody(req);
        const { skillId, prompt } = JSON.parse(body || '{}');
        if (!skillId || !prompt) return send(res, 400, { error: 'skillId and prompt required' });

        const skills = await scanSkillDirs(skillSources);
        const skill = skills.find(s => s.id === skillId);
        if (!skill) return send(res, 404, { error: 'skill not found' });

        const runId = 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const startedAt = new Date().toISOString();
        const { child } = spawnRun({ skillName: skill.name, prompt, projectDir });

        activeRuns.set(runId, {
          child, startedAt, skillId, prompt,
          status: 'running',
          stdoutBuf: '',
          eventListeners: [],
          finalEvents: null,
        });

        child.stdout.on('data', (d) => {
          const r = activeRuns.get(runId);
          if (!r) return;
          r.stdoutBuf = (r.stdoutBuf + d.toString('utf8')).slice(-1024 * 1024);
        });

        return send(res, 200, { runId });
      }
      // GET /api/runs/:id, GET /api/runs/:id/stream, POST /api/runs/:id/cancel — Tasks 7-9
      return serveStatic(req, res, publicDir);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  return { server, opts };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function defaultSpawnRun({ skillName, prompt, projectDir }) {
  const child = spawn('claude', [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
  ], { cwd: projectDir });
  return { child };
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  await main();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = resolve(args.project || process.cwd());
  if (!existsSync(projectDir)) {
    console.error(`--project path does not exist: ${projectDir}`);
    process.exit(1);
  }

  await new Promise((res, rej) => {
    const child = spawn('claude', ['--version']);
    child.on('error', () => rej(new Error('`claude` CLI not found on PATH. Install Claude Code first.')));
    child.on('exit', (code) => code === 0 ? res() : rej(new Error('`claude --version` failed')));
  }).catch((err) => { console.error(err.message); process.exit(1); });

  const dataDir = join(__dirname, 'data');
  await mkdir(dataDir, { recursive: true });

  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ lastProject: projectDir }, null, 2));

  const port = Number(process.env.PORT) || Number(args.port) || 3737;
  const { server } = await createApp({ projectDir, dataDir });
  server.listen(port, () => console.log(`Agentic OS listening on http://localhost:${port}  (project: ${projectDir})`));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--port') out.port = argv[++i];
  }
  return out;
}
