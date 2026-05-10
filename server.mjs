import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { scanSkillDirs, scanPluginsDir } from './lib/skills.mjs';
import { readRuns, appendRun, appendTranscriptEvent, readTranscript, lastRunAtBySkillId } from './lib/runs.mjs';
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
  ];

  const activeRuns = new Map(); // runId → { child, stdoutBuf, status, ... }

  const server = createServer(async (req, res) => {
    try {
      const { method, url } = req;
      if (method === 'GET' && url === '/api/skills') {
        const [user, plugins] = await Promise.all([
          scanSkillDirs(skillSources),
          scanPluginsDir(pluginsDir),
        ]);
        const skills = [...user, ...plugins];
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

        const [user, plugins] = await Promise.all([
          scanSkillDirs(skillSources),
          scanPluginsDir(pluginsDir),
        ]);
        const skill = [...user, ...plugins].find(s => s.id === skillId);
        if (!skill) return send(res, 404, { error: 'skill not found' });

        const runId = 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const startedAt = new Date().toISOString();
        const { child } = spawnRun({ skillName: skill.name, prompt, projectDir });

        // Critical: catch spawn errors so a bad `claude` path / missing binary
        // doesn't crash the whole server with an unhandled 'error' event.
        child.on('error', (err) => {
          const r = activeRuns.get(runId);
          if (!r) return;
          r.status = 'error';
          r.exitCode = -1;
          r.endedAt = new Date().toISOString();
          // Synthesise an SSE-friendly error event for live subscribers + transcript
          const errLine = JSON.stringify({ type: 'system', subtype: 'spawn_error', message: err.message });
          for (const listener of r.eventListeners) listener(errLine);
          for (const subscriber of r.subscribers || []) {
            try { subscriber.end(); } catch {}
          }
          r.writeChain = r.writeChain.then(() => appendTranscriptEvent(dataDir, runId, JSON.parse(errLine))).catch(() => {});
          r.writeChain.then(() => appendRun(dataDir, {
            runId, skillId: r.skillId, prompt: r.prompt,
            startedAt: r.startedAt, endedAt: r.endedAt,
            exitCode: -1, status: 'error',
          })).catch(() => {});
          setTimeout(() => activeRuns.delete(runId), 60_000).unref();
        });

        activeRuns.set(runId, {
          child, startedAt, skillId, prompt,
          status: 'running',
          stdoutBuf: '',
          eventListeners: [], // line → string callbacks
          subscribers: [],    // active res objects (for .end() on exit)
          writeChain: Promise.resolve(), // serializes transcript appends
          finalEvents: null,
        });

        let lineBuf = '';
        child.stdout.on('data', (d) => {
          const r = activeRuns.get(runId);
          if (!r) return;
          const text = d.toString('utf8');
          r.stdoutBuf = (r.stdoutBuf + text).slice(-1024 * 1024);
          lineBuf += text;
          let nl;
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            for (const listener of r.eventListeners) listener(line);
            // Persist each event to the per-run transcript file (serialized per run)
            let parsed;
            try { parsed = JSON.parse(line); } catch { continue; }
            r.writeChain = r.writeChain.then(() => appendTranscriptEvent(dataDir, runId, parsed)).catch(() => {});
          }
        });

        // Capture stderr as a synthetic event so it surfaces in the UI / transcript.
        // Claude's stream-json mode keeps real protocol on stdout; stderr usually
        // only appears for spawn-time failures (missing --verbose, bad path, etc.).
        child.stderr.on('data', (d) => {
          const r = activeRuns.get(runId);
          if (!r) return;
          const errLine = JSON.stringify({ type: 'system', subtype: 'stderr', text: d.toString('utf8') });
          for (const listener of r.eventListeners) listener(errLine);
          r.writeChain = r.writeChain.then(() => appendTranscriptEvent(dataDir, runId, JSON.parse(errLine))).catch(() => {});
        });

        child.on('exit', async (code) => {
          const r = activeRuns.get(runId);
          if (!r) return;
          r.status = r.status === 'cancelled' ? 'cancelled' : (code === 0 ? 'ok' : 'error');
          r.exitCode = code;
          r.endedAt = new Date().toISOString();
          // Defer SSE close so any in-flight stdout 'data' events flush to subscribers first
          setImmediate(() => {
            for (const subscriber of r.subscribers || []) {
              try { subscriber.end(); } catch {}
            }
          });
          // Wait for any pending transcript writes before recording the run
          await r.writeChain.catch(() => {});
          await appendRun(dataDir, {
            runId, skillId: r.skillId, prompt: r.prompt,
            startedAt: r.startedAt, endedAt: r.endedAt,
            exitCode: code, status: r.status,
          }).catch(() => {});
          // Keep entry in activeRuns briefly so reattach within ~60s can replay
          setTimeout(() => activeRuns.delete(runId), 60_000).unref();
        });

        return send(res, 200, { runId });
      }
      if (method === 'GET' && url.match(/^\/api\/runs\/[^/]+\/stream$/)) {
        const runId = url.split('/')[3];
        const r = activeRuns.get(runId);
        if (!r) return send(res, 404, { error: 'not found' });

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders();

        for (const line of r.stdoutBuf.split('\n')) {
          if (line.trim()) res.write(`data: ${line.trim()}\n\n`);
        }

        const listener = (line) => res.write(`data: ${line}\n\n`);
        r.eventListeners.push(listener);
        r.subscribers.push(res);

        req.on('close', () => {
          const cur = activeRuns.get(runId);
          if (!cur) return;
          cur.eventListeners = cur.eventListeners.filter(l => l !== listener);
          cur.subscribers = cur.subscribers.filter(s => s !== res);
        });

        if (r.status === 'ended') res.end();
        return;
      }
      if (method === 'GET' && url.match(/^\/api\/runs\/[^/]+$/)) {
        const runId = url.split('/').pop();
        const active = activeRuns.get(runId);
        if (active) {
          const transcript = await readTranscript(dataDir, runId);
          return send(res, 200, {
            runId, skillId: active.skillId, prompt: active.prompt,
            startedAt: active.startedAt, endedAt: active.endedAt || null,
            exitCode: active.exitCode ?? null, status: active.status,
            transcript,
          });
        }
        const allRuns = await readRuns(dataDir, Number.MAX_SAFE_INTEGER);
        const run = allRuns.find(r => r.runId === runId);
        if (!run) return send(res, 404, { error: 'not found' });
        const transcript = await readTranscript(dataDir, runId);
        return send(res, 200, { ...run, transcript });
      }
      if (method === 'POST' && url.match(/^\/api\/runs\/[^/]+\/cancel$/)) {
        const runId = url.split('/')[3];
        const r = activeRuns.get(runId);
        if (!r) return send(res, 404, { error: 'not found' });
        try { r.child.kill('SIGTERM'); } catch {}
        r.status = 'cancelled';
        return send(res, 200, { ok: true });
      }
      // GET /api/runs/:id — Task 9
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

function makeSpawnRun(claudePath) {
  // On Windows, `claude` is a .cmd shim. Node 18+ refuses to spawn .cmd files
  // directly (CVE-2024-27980 mitigation), so we route through the shell. On
  // POSIX we spawn directly. Args are passed as an array — Node escapes them
  // for the chosen shell. Prompts containing shell metacharacters are still
  // a theoretical injection vector here; this is a personal-use dev tool, but
  // a v1.x improvement should pass the prompt via stdin instead of argv.
  const useShell = process.platform === 'win32';
  return function spawnRun({ skillName, prompt, projectDir }) {
    const child = spawn(claudePath, [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose', // required by claude when --output-format=stream-json + --print
      '--permission-mode', 'bypassPermissions',
    ], { cwd: projectDir, shell: useShell });
    return { child };
  };
}

// Default factory used in non-test environments where boot has resolved the path.
function defaultSpawnRun({ skillName, prompt, projectDir }) {
  // Last-resort: use shell:true so PATH lookup works. Args quoted via spawn array form.
  const child = spawn('claude', [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
  ], { cwd: projectDir, shell: process.platform === 'win32' });
  return { child };
}

function findClaudeOnPath() {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(cmd, ['claude']);
    let stdout = '';
    child.stdout.on('data', d => stdout += d);
    child.on('error', () => reject(new Error('`claude` CLI not found on PATH. Install Claude Code first.')));
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error('`claude` CLI not found on PATH. Install Claude Code first.'));
      const paths = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!paths.length) return reject(new Error('`claude` CLI path could not be resolved'));
      // On Windows, `where` returns the bare shim first AND the .cmd. The bare shim is a
      // POSIX shell script that Node can't spawn directly — we need a Windows-executable
      // path (.cmd / .exe / .bat). Prefer those if present.
      if (process.platform === 'win32') {
        const winExec = paths.find(p => /\.(cmd|exe|bat|ps1)$/i.test(p));
        return resolve(winExec || paths[0]);
      }
      resolve(paths[0]);
    });
  });
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

  let claudePath;
  try {
    claudePath = await findClaudeOnPath();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const dataDir = join(__dirname, 'data');
  await mkdir(dataDir, { recursive: true });

  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ lastProject: projectDir, claudePath }, null, 2));

  const port = Number(process.env.PORT) || Number(args.port) || 3737;
  const { server } = await createApp({ projectDir, dataDir, spawnRun: makeSpawnRun(claudePath) });
  server.listen(port, () => console.log(`Agentic OS listening on http://localhost:${port}  (project: ${projectDir}, claude: ${claudePath})`));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--port') out.port = argv[++i];
  }
  return out;
}
