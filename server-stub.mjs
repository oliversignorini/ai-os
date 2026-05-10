import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3737;

// Canned data
const STUB_SKILLS = [
  { id: 'user/research', source: 'user', path: '~/.claude/skills/research/SKILL.md',
    name: 'research', description: 'Research a topic via web search', domain: 'research', lastRunAt: '2026-05-09T20:14:00Z' },
  { id: 'project/ingest-resources', source: 'project', path: 'vault/.claude/skills/ingest-resources/SKILL.md',
    name: 'ingest-resources', description: 'Ingest Notion captures into the vault', domain: 'vault', lastRunAt: '2026-05-10T08:00:00Z' },
  { id: 'project/raw-cluster', source: 'project', path: 'vault/.claude/skills/raw-cluster/SKILL.md',
    name: 'raw-cluster', description: 'Cluster raw notes into notebook candidates', domain: 'vault', lastRunAt: null },
  { id: 'project/transcribe-youtube', source: 'project', path: 'vault/.claude/skills/transcribe-youtube/SKILL.md',
    name: 'transcribe-youtube', description: 'Save a YouTube video as a vault note', domain: 'capture', lastRunAt: null },
  { id: 'plugin:remember/remember', source: 'plugin:remember', path: '~/.claude/plugins/.../remember/SKILL.md',
    name: 'remember', description: 'Save session state', domain: 'system', lastRunAt: '2026-05-10T11:30:00Z' },
];

const STUB_RUNS = [
  { runId: 'r-001', skillId: 'project/ingest-resources', prompt: '/ingest-resources',
    startedAt: '2026-05-10T08:00:00Z', endedAt: '2026-05-10T08:00:42Z', exitCode: 0, status: 'ok' },
  { runId: 'r-002', skillId: 'user/research', prompt: '/research mortgage broker AI',
    startedAt: '2026-05-09T20:14:00Z', endedAt: '2026-05-09T20:18:11Z', exitCode: 0, status: 'ok' },
  { runId: 'r-003', skillId: 'project/raw-cluster', prompt: '/raw-cluster',
    startedAt: '2026-05-08T18:00:00Z', endedAt: null, exitCode: null, status: 'cancelled' },
];

const STUB_VAULT_CHANGES = [
  { status: 'M', path: '20 - Business/AI Operating System.md' },
  { status: 'A', path: '20 - Business/AI Operating System/specs/v1-friend-share-pack.md' },
  { status: 'M', path: '45 - Research/vertical-ai-os-tool-stack/report.md' },
];

const STUB_USAGE = { fiveHourPercentUsed: 47, weeklyPercentUsed: 23 };

// In-memory active-runs map (for the streaming endpoint)
const activeRuns = new Map();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = join(PUBLIC_DIR, urlPath);
  try {
    const data = await readFile(filePath);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const { url, method } = req;

  if (method === 'GET' && url === '/api/skills') return send(res, 200, STUB_SKILLS);
  if (method === 'GET' && url.startsWith('/api/runs/') && url.endsWith('/stream')) {
    const runId = url.split('/')[3];
    return streamFakeRun(res, runId);
  }
  if (method === 'GET' && url.startsWith('/api/runs/')) {
    const runId = url.split('/').pop();
    const run = STUB_RUNS.find(r => r.runId === runId);
    if (!run) return send(res, 404, { error: 'not found' });
    return send(res, 200, { ...run, transcript: stubTranscript(runId) });
  }
  if (method === 'GET' && url.startsWith('/api/runs')) return send(res, 200, STUB_RUNS);
  if (method === 'GET' && url === '/api/vault-changes') return send(res, 200, STUB_VAULT_CHANGES);
  if (method === 'GET' && url === '/api/usage') return send(res, 200, STUB_USAGE);
  if (method === 'POST' && url === '/api/run') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const runId = 'r-stub-' + Date.now();
      activeRuns.set(runId, { startedAt: new Date().toISOString() });
      send(res, 200, { runId });
    });
    return;
  }
  if (method === 'POST' && url.match(/^\/api\/runs\/[^/]+\/cancel$/)) {
    const runId = url.split('/')[3];
    activeRuns.delete(runId);
    return send(res, 200, { ok: true });
  }

  return serveStatic(req, res);
});

function streamFakeRun(res, runId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-opus-4-7' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.\n' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'README.md' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '# Hello\nThis is the README.' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done. The README says hello.\n' }] } },
    { type: 'result', subtype: 'success', exit_code: 0 },
  ];
  let i = 0;
  const interval = setInterval(() => {
    if (i >= events.length) {
      clearInterval(interval);
      res.end();
      activeRuns.delete(runId);
      return;
    }
    res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
  }, 600);
  res.on('close', () => clearInterval(interval));
}

function stubTranscript(runId) {
  // Same shape as live events, used by the past-run viewer
  return [
    { type: 'system', subtype: 'init', model: 'claude-opus-4-7' },
    { type: 'assistant', message: { content: [{ type: 'text', text: `(historical transcript for ${runId})\n` }] } },
    { type: 'result', subtype: 'success', exit_code: 0 },
  ];
}

server.listen(PORT, () => console.log(`Stub server listening on http://localhost:${PORT}`));
