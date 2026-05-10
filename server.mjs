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
import { ensureProjectDataDir, readConfig, writeConfig, pushRecent, describeProject, migrateLegacyData } from './lib/project.mjs';
import { listProjectFiles } from './lib/files.mjs';
import {
  ensureConvDir,
  newConversationId,
  appendConversationIndex,
  readConversationIndex,
  appendConversationEvent,
  readConversationTranscript,
  titleFromFirstMessage,
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  MODELS,
  normalizeModel,
  computeUsage,
} from './lib/conversations.mjs';

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
    dataRoot,
    userSkillsDir = join(homedir(), '.claude', 'skills'),
    pluginsDir = join(homedir(), '.claude', 'plugins', 'cache'),
    statsCachePath = join(homedir(), '.claude', 'stats-cache.json'),
    publicDir = PUBLIC_DIR,
    spawnRun = defaultSpawnRun,
    spawnChat,
  } = opts;

  // Mutable so /api/project can swap projects at runtime. Handlers read from
  // `state.*` (never the closure-captured opts above) so a switch takes effect
  // for the very next request. In-flight runs capture their own dataDir at
  // spawn time below — switching projects doesn't redirect their persistence.
  const state = {
    projectDir,
    dataDir,
    dataRoot: dataRoot || dirname(dataDir),
    skillSources: buildSkillSources(projectDir, userSkillsDir),
  };

  const activeRuns = new Map(); // runId → { child, stdoutBuf, status, ... }
  // Active chat conversations. Keyed by conversationId (= claude --session-id).
  // Same shape as activeRuns: { child, eventListeners, subscribers, writeChain,
  // dataDir, lineBuf, status, lastMessageAt }.
  const activeConversations = new Map();

  const server = createServer(async (req, res) => {
    try {
      const { method, url } = req;
      if (method === 'GET' && url === '/api/skills') {
        const [user, plugins] = await Promise.all([
          scanSkillDirs(state.skillSources),
          scanPluginsDir(pluginsDir),
        ]);
        const skills = [...user, ...plugins];
        const lastRunAt = await lastRunAtBySkillId(state.dataDir);
        return send(res, 200, skills.map(s => ({ ...s, lastRunAt: lastRunAt[s.id] || null })));
      }
      if (method === 'GET' && url.startsWith('/api/runs') && !url.match(/^\/api\/runs\/[^/]+/)) {
        const u = new URL(url, 'http://localhost');
        const limit = Number(u.searchParams.get('limit')) || 50;
        return send(res, 200, await readRuns(state.dataDir, limit));
      }
      if (method === 'GET' && url === '/api/vault-changes') {
        return send(res, 200, await vaultChanges(state.projectDir));
      }
      if (method === 'GET' && url === '/api/usage') {
        return send(res, 200, await readUsage(statsCachePath));
      }
      if (method === 'GET' && url.startsWith('/api/files')) {
        const u = new URL(url, 'http://localhost');
        const query = u.searchParams.get('q') || '';
        const files = await listProjectFiles(state.projectDir, { query });
        return send(res, 200, files);
      }
      if (method === 'GET' && url === '/api/project') {
        const cfg = await readConfig(state.dataRoot);
        return send(res, 200, {
          current: describeProject(state.projectDir),
          recents: (cfg.recentProjects || []).map(describeProject),
        });
      }
      if (method === 'POST' && url === '/api/project') {
        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
        const requested = parsed.path && resolve(parsed.path);
        if (!requested) return send(res, 400, { error: 'path required' });
        if (!existsSync(requested)) return send(res, 400, { error: 'path does not exist' });
        state.projectDir = requested;
        state.dataDir = await ensureProjectDataDir(state.dataRoot, requested);
        state.skillSources = buildSkillSources(requested, userSkillsDir);
        const cfg = await readConfig(state.dataRoot);
        await writeConfig(state.dataRoot, {
          lastProject: requested,
          recentProjects: pushRecent(cfg.recentProjects, requested),
        });
        return send(res, 200, { current: describeProject(requested) });
      }
      if (method === 'POST' && url === '/api/run') {
        const body = await readBody(req);
        const { skillId, prompt } = JSON.parse(body || '{}');
        if (!skillId || !prompt) return send(res, 400, { error: 'skillId and prompt required' });

        const [user, plugins] = await Promise.all([
          scanSkillDirs(state.skillSources),
          scanPluginsDir(pluginsDir),
        ]);
        const skill = [...user, ...plugins].find(s => s.id === skillId);
        if (!skill) return send(res, 404, { error: 'skill not found' });

        const runId = 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const startedAt = new Date().toISOString();
        // Capture so a project switch mid-run doesn't redirect this run's writes
        const runDataDir = state.dataDir;
        const { child } = spawnRun({ skillName: skill.name, prompt, projectDir: state.projectDir });

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
          r.writeChain = r.writeChain.then(() => appendTranscriptEvent(runDataDir, runId, JSON.parse(errLine))).catch(() => {});
          r.writeChain.then(() => appendRun(runDataDir, {
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
            r.writeChain = r.writeChain.then(() => appendTranscriptEvent(runDataDir, runId, parsed)).catch(() => {});
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
          r.writeChain = r.writeChain.then(() => appendTranscriptEvent(runDataDir, runId, JSON.parse(errLine))).catch(() => {});
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
          await appendRun(runDataDir, {
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
          const transcript = await readTranscript(state.dataDir, runId);
          return send(res, 200, {
            runId, skillId: active.skillId, prompt: active.prompt,
            startedAt: active.startedAt, endedAt: active.endedAt || null,
            exitCode: active.exitCode ?? null, status: active.status,
            transcript,
          });
        }
        const allRuns = await readRuns(state.dataDir, Number.MAX_SAFE_INTEGER);
        const run = allRuns.find(r => r.runId === runId);
        if (!run) return send(res, 404, { error: 'not found' });
        const transcript = await readTranscript(state.dataDir, runId);
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
      // ─── CONVERSATIONS (chat mode) ───────────────────────────────────────
      if (method === 'GET' && url === '/api/conversations') {
        return send(res, 200, await readConversationIndex(state.dataDir));
      }
      if (method === 'POST' && url === '/api/conversations') {
        if (!spawnChat) return send(res, 500, { error: 'chat mode not configured' });
        const body = await readBody(req);
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch {}
        const conversationId = newConversationId();
        const createdAt = new Date().toISOString();
        const permissionMode = normalizePermissionMode(parsed.permissionMode);
        const model = normalizeModel(parsed.model);
        await ensureConvDir(state.dataDir);
        await appendConversationIndex(state.dataDir, {
          conversationId, title: 'New chat', createdAt, lastMessageAt: createdAt, permissionMode, model,
        });
        // Spawn lazily on first message — don't burn a child for an empty chat
        return send(res, 200, { conversationId, title: 'New chat', createdAt, permissionMode, model });
      }
      if (method === 'PATCH' && url.match(/^\/api\/conversations\/[^/]+$/)) {
        const id = url.split('/').pop();
        const body = await readBody(req);
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
        const idx = await readConversationIndex(state.dataDir);
        const meta = idx.find(c => c.conversationId === id);
        if (!meta) return send(res, 404, { error: 'not found' });
        // Patchable fields: permissionMode (kills child so next message respawns
        // with the new mode), title (display only).
        let updated = { ...meta };
        if (parsed.permissionMode !== undefined) {
          updated.permissionMode = normalizePermissionMode(parsed.permissionMode);
          const conv = activeConversations.get(id);
          if (conv) { try { conv.child.kill('SIGTERM'); } catch {} }
        }
        if (parsed.title !== undefined) {
          const t = String(parsed.title).trim().slice(0, 100);
          if (t) updated.title = t;
        }
        if (parsed.model !== undefined) {
          updated.model = normalizeModel(parsed.model);
          const conv = activeConversations.get(id);
          if (conv) { try { conv.child.kill('SIGTERM'); } catch {} }
        }
        if (updated === meta) return send(res, 400, { error: 'no patchable fields' });
        await appendConversationIndex(state.dataDir, updated);
        return send(res, 200, updated);
      }
      if (method === 'DELETE' && url.match(/^\/api\/conversations\/[^/]+$/)) {
        const id = url.split('/').pop();
        const idx = await readConversationIndex(state.dataDir);
        const meta = idx.find(c => c.conversationId === id);
        if (!meta) return send(res, 404, { error: 'not found' });
        // Tombstone the entry by appending a deleted flag — readConversationIndex
        // collapses by id (last write wins) and skips deleted ones below.
        await appendConversationIndex(state.dataDir, { ...meta, deleted: true });
        // Kill any active child + drop transcript file
        const conv = activeConversations.get(id);
        if (conv) { try { conv.child.kill('SIGTERM'); } catch {} }
        try {
          const { unlink } = await import('node:fs/promises');
          await unlink(join(state.dataDir, 'conversations', `${id}.jsonl`));
        } catch {}
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && url.match(/^\/api\/conversations\/[^/]+$/)) {
        const id = url.split('/').pop();
        const transcript = await readConversationTranscript(state.dataDir, id);
        const idx = await readConversationIndex(state.dataDir);
        const meta = idx.find(c => c.conversationId === id);
        if (!meta) return send(res, 404, { error: 'not found' });
        const active = activeConversations.get(id);
        return send(res, 200, {
          ...meta,
          transcript,
          isActive: !!active,
          status: active?.status || 'idle',
          usage: computeUsage(transcript),
        });
      }
      if (method === 'POST' && url.match(/^\/api\/conversations\/[^/]+\/message$/)) {
        if (!spawnChat) return send(res, 500, { error: 'chat mode not configured' });
        const id = url.split('/')[3];
        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
        const text = (parsed.text || '').toString();
        if (!text.trim()) return send(res, 400, { error: 'text required' });

        const idx = await readConversationIndex(state.dataDir);
        const meta = idx.find(c => c.conversationId === id);
        if (!meta) return send(res, 404, { error: 'conversation not found' });

        let conv = activeConversations.get(id);
        if (!conv) {
          // Spawn (or resume) the child. Resume if there's already transcript on disk.
          const transcript = await readConversationTranscript(state.dataDir, id);
          const isResume = transcript.length > 0;
          const convDataDir = state.dataDir;
          const { child } = spawnChat({
            projectDir: state.projectDir,
            sessionId: id,
            resume: isResume,
            permissionMode: meta.permissionMode,
            model: meta.model,
          });
          conv = {
            child,
            dataDir: convDataDir,
            status: 'running',
            lineBuf: '',
            eventListeners: [],
            subscribers: [],
            writeChain: Promise.resolve(),
            stdoutBuf: '',
          };
          activeConversations.set(id, conv);

          child.on('error', (err) => {
            const c = activeConversations.get(id);
            if (!c) return;
            c.status = 'error';
            const errLine = JSON.stringify({ type: 'system', subtype: 'spawn_error', message: err.message });
            for (const l of c.eventListeners) l(errLine);
            for (const s of c.subscribers) try { s.end(); } catch {}
            c.writeChain = c.writeChain.then(() => appendConversationEvent(convDataDir, id, JSON.parse(errLine))).catch(() => {});
            activeConversations.delete(id);
          });

          child.stdout.on('data', (d) => {
            const c = activeConversations.get(id);
            if (!c) return;
            const txt = d.toString('utf8');
            c.stdoutBuf = (c.stdoutBuf + txt).slice(-1024 * 1024);
            c.lineBuf += txt;
            let nl;
            while ((nl = c.lineBuf.indexOf('\n')) >= 0) {
              const line = c.lineBuf.slice(0, nl).trim();
              c.lineBuf = c.lineBuf.slice(nl + 1);
              if (!line) continue;
              for (const l of c.eventListeners) l(line);
              let ev;
              try { ev = JSON.parse(line); } catch { continue; }
              c.writeChain = c.writeChain.then(() => appendConversationEvent(convDataDir, id, ev)).catch(() => {});
            }
          });

          child.stderr.on('data', (d) => {
            const c = activeConversations.get(id);
            if (!c) return;
            const errLine = JSON.stringify({ type: 'system', subtype: 'stderr', text: d.toString('utf8') });
            for (const l of c.eventListeners) l(errLine);
            c.writeChain = c.writeChain.then(() => appendConversationEvent(convDataDir, id, JSON.parse(errLine))).catch(() => {});
          });

          child.on('exit', (code) => {
            const c = activeConversations.get(id);
            if (!c) return;
            c.status = code === 0 ? 'idle' : 'error';
            for (const s of c.subscribers) setImmediate(() => { try { s.end(); } catch {} });
            // Don't delete from map immediately — let next message resume.
            // But the child is dead, so nuke the entry so next call re-spawns with --resume.
            activeConversations.delete(id);
          });
        }

        // Write user message to child stdin (JSON-Lines protocol)
        const userMsg = { type: 'user', message: { role: 'user', content: text } };
        try {
          conv.child.stdin.write(JSON.stringify(userMsg) + '\n');
        } catch (e) {
          return send(res, 500, { error: 'write failed: ' + e.message });
        }

        // Bookkeeping: update title from first message + bump lastMessageAt
        const lastMessageAt = new Date().toISOString();
        const title = meta.title === 'New chat' ? titleFromFirstMessage(text) : meta.title;
        await appendConversationIndex(state.dataDir, {
          conversationId: id, title, createdAt: meta.createdAt, lastMessageAt,
        });

        return send(res, 200, { ok: true, lastMessageAt, title });
      }
      if (method === 'GET' && url.match(/^\/api\/conversations\/[^/]+\/stream$/)) {
        const id = url.split('/')[3];
        const conv = activeConversations.get(id);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders();
        if (!conv) {
          // Inactive — just close after a hint event so client can fall back to /transcript
          res.write(`data: ${JSON.stringify({ type: 'system', subtype: 'inactive' })}\n\n`);
          res.end();
          return;
        }
        // Replay buffered stdout, then live-stream
        for (const line of conv.stdoutBuf.split('\n')) {
          if (line.trim()) res.write(`data: ${line.trim()}\n\n`);
        }
        const listener = (line) => res.write(`data: ${line}\n\n`);
        conv.eventListeners.push(listener);
        conv.subscribers.push(res);
        req.on('close', () => {
          const cur = activeConversations.get(id);
          if (!cur) return;
          cur.eventListeners = cur.eventListeners.filter(l => l !== listener);
          cur.subscribers = cur.subscribers.filter(s => s !== res);
        });
        return;
      }
      if (method === 'POST' && url.match(/^\/api\/conversations\/[^/]+\/cancel$/)) {
        const id = url.split('/')[3];
        const conv = activeConversations.get(id);
        if (!conv) return send(res, 404, { error: 'not active' });
        try { conv.child.kill('SIGTERM'); } catch {}
        return send(res, 200, { ok: true });
      }

      return serveStatic(req, res, publicDir);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  return { server, opts };
}

function buildSkillSources(projectDir, userSkillsDir) {
  return [
    { dir: userSkillsDir, source: 'user' },
    { dir: join(projectDir, '.claude', 'skills'), source: 'project' },
  ];
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

// Chat-mode spawn: reads JSON-lines from stdin, writes JSON-lines to stdout.
// We assign the session UUID up front so subsequent --resume works against
// our internal id. --replay-user-messages echoes the user message back on
// stdout, so the SSE consumer sees both halves of the conversation in one
// stream and doesn't need to splice.
export function makeSpawnChat(claudePath) {
  const useShell = process.platform === 'win32';
  return function spawnChat({ projectDir, sessionId, resume = false, permissionMode = DEFAULT_PERMISSION_MODE, model = null }) {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--replay-user-messages',
      '--include-partial-messages', // emit stream_event lines with text deltas
      '--permission-mode', normalizePermissionMode(permissionMode),
    ];
    const m = normalizeModel(model);
    if (m) args.push('--model', m);
    if (resume) args.push('--resume', sessionId);
    else args.push('--session-id', sessionId);
    const child = spawn(claudePath, args, { cwd: projectDir, shell: useShell, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const dataRoot = join(__dirname, 'data');
  await mkdir(dataRoot, { recursive: true });
  const cfg = await readConfig(dataRoot);

  // Resolution order: --project flag > config.lastProject > cwd. The last fallback
  // mainly bites first-run; after one switch via the UI, lastProject takes over.
  const projectDir = resolve(args.project || cfg.lastProject || process.cwd());
  if (!existsSync(projectDir)) {
    console.error(`Project path does not exist: ${projectDir}`);
    process.exit(1);
  }

  let claudePath;
  try {
    claudePath = await findClaudeOnPath();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const dataDir = await ensureProjectDataDir(dataRoot, projectDir);
  const migrated = await migrateLegacyData(dataRoot, dataDir);
  if (migrated) console.log(`Migrated legacy data/runs.jsonl + data/transcripts → ${dataDir}`);
  await writeConfig(dataRoot, {
    lastProject: projectDir,
    claudePath,
    recentProjects: pushRecent(cfg.recentProjects, projectDir),
  });

  const port = Number(process.env.PORT) || Number(args.port) || 3737;
  const { server } = await createApp({
    projectDir, dataDir, dataRoot,
    spawnRun: makeSpawnRun(claudePath),
    spawnChat: makeSpawnChat(claudePath),
  });
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
