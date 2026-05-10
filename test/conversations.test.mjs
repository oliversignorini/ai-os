import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  newConversationId,
  appendConversationIndex,
  readConversationIndex,
  appendConversationEvent,
  readConversationTranscript,
  titleFromFirstMessage,
  normalizePermissionMode,
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  normalizeModel,
  MODELS,
  computeUsage,
} from '../lib/conversations.mjs';
import { createApp } from '../server.mjs';

test('newConversationId returns a UUID v4-shaped string', () => {
  const id = newConversationId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('titleFromFirstMessage truncates and falls back', () => {
  assert.equal(titleFromFirstMessage('Short'), 'Short');
  assert.equal(titleFromFirstMessage(''), 'New chat');
  assert.equal(titleFromFirstMessage('  '), 'New chat');
  const long = 'a'.repeat(100);
  assert.equal(titleFromFirstMessage(long).length, 60);
});

test('appendConversationIndex + readConversationIndex collapses to most recent per id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conv-idx-'));
  await appendConversationIndex(dir, { conversationId: 'a', title: 'first', createdAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-01-01T00:00:00Z' });
  await appendConversationIndex(dir, { conversationId: 'b', title: 'second', createdAt: '2026-01-02T00:00:00Z', lastMessageAt: '2026-01-02T00:00:00Z' });
  await appendConversationIndex(dir, { conversationId: 'a', title: 'first updated', createdAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-01-03T00:00:00Z' });

  const idx = await readConversationIndex(dir);
  assert.equal(idx.length, 2);
  // Sorted newest first by lastMessageAt
  assert.equal(idx[0].conversationId, 'a');
  assert.equal(idx[0].title, 'first updated');
  assert.equal(idx[1].conversationId, 'b');
  await rm(dir, { recursive: true, force: true });
});

test('appendConversationEvent + readConversationTranscript roundtrip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conv-tr-'));
  await appendConversationEvent(dir, 'c1', { type: 'system', subtype: 'init' });
  await appendConversationEvent(dir, 'c1', { type: 'user', message: { content: 'hi' } });
  const tr = await readConversationTranscript(dir, 'c1');
  assert.equal(tr.length, 2);
  assert.equal(tr[0].subtype, 'init');
  assert.equal(tr[1].message.content, 'hi');
  await rm(dir, { recursive: true, force: true });
});

test('readConversationTranscript returns [] when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conv-empty-'));
  const tr = await readConversationTranscript(dir, 'nope');
  assert.deepEqual(tr, []);
  await rm(dir, { recursive: true, force: true });
});

// Fake child for chat-mode tests — captures stdin writes so we can assert on
// the protocol the server sends to claude.
function fakeChat() {
  const ee = new EventEmitter();
  ee.stdout = new Readable({ read() {} });
  ee.stderr = new Readable({ read() {} });
  ee.stdinWrites = [];
  ee.stdin = new Writable({
    write(chunk, _enc, cb) { ee.stdinWrites.push(chunk.toString('utf8')); cb(); },
  });
  ee.kill = () => { setImmediate(() => ee.emit('exit', null)); };
  return ee;
}

test('POST /api/conversations creates entry without spawning child', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pchat-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dchat-'));
  let spawnCount = 0;
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: () => { spawnCount++; return { child: fakeChat() }; },
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();

  const created = await (await fetch(`http://localhost:${port}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
  assert.match(created.conversationId, /^[0-9a-f-]{36}$/);
  assert.equal(spawnCount, 0, 'should not spawn until first message');

  const list = await (await fetch(`http://localhost:${port}/api/conversations`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].conversationId, created.conversationId);

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('POST /message spawns child + writes JSON-Lines user msg to stdin', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pchat2-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dchat2-'));
  let spawnedWith = null;
  let fakeChild;
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: (opts) => { spawnedWith = opts; fakeChild = fakeChat(); return { child: fakeChild }; },
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  const { conversationId } = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();

  const r = await fetch(`${base}/api/conversations/${conversationId}/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.title, 'hello');

  // Verify spawn args
  assert.equal(spawnedWith.sessionId, conversationId);
  assert.equal(spawnedWith.resume, false);
  assert.equal(spawnedWith.projectDir, projectDir);

  // Verify what was written to child stdin
  assert.equal(fakeChild.stdinWrites.length, 1);
  const sent = JSON.parse(fakeChild.stdinWrites[0]);
  assert.equal(sent.type, 'user');
  assert.equal(sent.message.role, 'user');
  assert.equal(sent.message.content, 'hello');

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('POST /message on second send to same conversation reuses existing child (no respawn)', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pchat3-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dchat3-'));
  let spawnCount = 0;
  let lastChild;
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: () => { spawnCount++; lastChild = fakeChat(); return { child: lastChild }; },
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  const { conversationId } = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
  await fetch(`${base}/api/conversations/${conversationId}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'one' }) });
  await fetch(`${base}/api/conversations/${conversationId}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'two' }) });

  assert.equal(spawnCount, 1, 'should reuse the long-lived child');
  assert.equal(lastChild.stdinWrites.length, 2);

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('normalizePermissionMode returns default for invalid input', () => {
  assert.equal(normalizePermissionMode('acceptEdits'), 'acceptEdits');
  assert.equal(normalizePermissionMode('bypassPermissions'), 'bypassPermissions');
  assert.equal(normalizePermissionMode('plan'), 'plan');
  assert.equal(normalizePermissionMode('garbage'), DEFAULT_PERMISSION_MODE);
  assert.equal(normalizePermissionMode(undefined), DEFAULT_PERMISSION_MODE);
  assert.equal(normalizePermissionMode(null), DEFAULT_PERMISSION_MODE);
  // Default must be the safer choice
  assert.equal(DEFAULT_PERMISSION_MODE, 'acceptEdits');
});

test('POST /api/conversations defaults permissionMode and accepts override', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pperm-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dperm-'));
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: () => ({ child: fakeChat() }),
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  // Default
  let body = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
  assert.equal(body.permissionMode, 'acceptEdits');

  // Explicit override
  body = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: JSON.stringify({ permissionMode: 'plan' }), headers: { 'content-type': 'application/json' } })).json();
  assert.equal(body.permissionMode, 'plan');

  // Garbage falls back to default
  body = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: JSON.stringify({ permissionMode: 'evil' }), headers: { 'content-type': 'application/json' } })).json();
  assert.equal(body.permissionMode, 'acceptEdits');

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('PATCH /api/conversations/:id updates permissionMode and is forwarded to spawnChat', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pperm2-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dperm2-'));
  let lastSpawnMode = null;
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: (opts) => { lastSpawnMode = opts.permissionMode; return { child: fakeChat() }; },
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  const { conversationId } = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();

  // PATCH to bypassPermissions
  const patched = await (await fetch(`${base}/api/conversations/${conversationId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ permissionMode: 'bypassPermissions' }),
  })).json();
  assert.equal(patched.permissionMode, 'bypassPermissions');

  // Send a message — spawnChat should now receive the new mode
  await fetch(`${base}/api/conversations/${conversationId}/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(lastSpawnMode, 'bypassPermissions');

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('normalizeModel allows whitelist + nulls everything else', () => {
  for (const m of MODELS) assert.equal(normalizeModel(m), m);
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel(undefined), null);
  assert.equal(normalizeModel('garbage'), null);
  assert.equal(normalizeModel('GPT-4'), null);
});

test('computeUsage sums cost + tokens across result events', () => {
  const transcript = [
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant' },
    { type: 'result', subtype: 'success', total_cost_usd: 0.05, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 } },
    { type: 'user' },
    { type: 'assistant' },
    { type: 'result', subtype: 'success', total_cost_usd: 0.03, usage: { input_tokens: 5, output_tokens: 15, cache_creation_input_tokens: 50 } },
  ];
  const u = computeUsage(transcript);
  assert.equal(u.turns, 2);
  assert.equal(u.costUsd.toFixed(2), '0.08');
  assert.equal(u.tokensIn, 15);
  assert.equal(u.tokensOut, 35);
  assert.equal(u.cacheReadTokens, 100);
  assert.equal(u.cacheCreationTokens, 50);
});

test('computeUsage handles missing/empty fields gracefully', () => {
  assert.deepEqual(computeUsage([]), { costUsd: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0 });
  assert.deepEqual(computeUsage(null), { costUsd: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0 });
  // Result event without usage doesn't crash
  const u = computeUsage([{ type: 'result', subtype: 'success' }]);
  assert.equal(u.turns, 1);
  assert.equal(u.costUsd, 0);
});

test('POST /api/conversations accepts model + spawnChat receives it as --model', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pmod-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dmod-'));
  let lastSpawnModel = 'unset';
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: (opts) => { lastSpawnModel = opts.model; return { child: fakeChat() }; },
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  // Default model is null (let CLI decide)
  const a = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
  assert.equal(a.model, null);

  // Explicit haiku is honored, garbage drops to null
  const b = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: JSON.stringify({ model: 'haiku' }), headers: { 'content-type': 'application/json' } })).json();
  assert.equal(b.model, 'haiku');
  const c = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: JSON.stringify({ model: 'gpt-4' }), headers: { 'content-type': 'application/json' } })).json();
  assert.equal(c.model, null);

  // Sending a message forwards the chosen model
  await fetch(`${base}/api/conversations/${b.conversationId}/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(lastSpawnModel, 'haiku');

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('GET /api/conversations/:id returns derived usage', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pus-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dus-'));
  const dataDir = join(dataRoot, 'projects', 'x');
  const app = await createApp({
    projectDir, dataDir, dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: () => ({ child: fakeChat() }),
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  const { conversationId } = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();

  // Manually inject a result event into the transcript file
  await appendConversationEvent(dataDir, conversationId, {
    type: 'result', subtype: 'success', total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 200 },
  });

  const data = await (await fetch(`${base}/api/conversations/${conversationId}`)).json();
  assert.equal(data.usage.turns, 1);
  assert.equal(data.usage.costUsd.toFixed(2), '0.42');
  assert.equal(data.usage.tokensIn + data.usage.tokensOut, 300);

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('PATCH /api/conversations/:id can rename title', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'prn-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'drn-'));
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: () => ({ child: fakeChat() }),
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  const { conversationId } = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
  const r = await fetch(`${base}/api/conversations/${conversationId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'My renamed chat' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.title, 'My renamed chat');

  // Verify the rename is visible in the list
  const list = await (await fetch(`${base}/api/conversations`)).json();
  assert.equal(list[0].title, 'My renamed chat');

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('DELETE /api/conversations/:id tombstones + hides from list', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pdel-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'ddel-'));
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: () => ({ child: fakeChat() }),
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  const { conversationId: a } = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
  const { conversationId: b } = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();

  let list = await (await fetch(`${base}/api/conversations`)).json();
  assert.equal(list.length, 2);

  const r = await fetch(`${base}/api/conversations/${a}`, { method: 'DELETE' });
  assert.equal(r.status, 200);

  list = await (await fetch(`${base}/api/conversations`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].conversationId, b);

  // Also verify GET on the deleted one returns 404
  const r2 = await fetch(`${base}/api/conversations/${a}`);
  assert.equal(r2.status, 404);

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

test('POST /message rejects empty text and unknown conversationId', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pchat4-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'dchat4-'));
  const app = await createApp({
    projectDir, dataDir: join(dataRoot, 'projects', 'x'), dataRoot,
    userSkillsDir: '/no', pluginsDir: '/no', statsCachePath: '/no',
    spawnRun: () => { throw new Error('unused'); },
    spawnChat: () => ({ child: fakeChat() }),
  });
  await new Promise(r => app.server.listen(0, r));
  const { port } = app.server.address();
  const base = `http://localhost:${port}`;

  const { conversationId } = await (await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
  let r = await fetch(`${base}/api/conversations/${conversationId}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ' }) });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/api/conversations/nope/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(r.status, 404);

  await new Promise(r => app.server.close(r));
  await rm(projectDir, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});
