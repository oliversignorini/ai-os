import { join } from 'node:path';
import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Conversations live under <projectDataDir>/conversations/.
//   index.jsonl        — one line per conversation { conversationId, title, createdAt, lastMessageAt }
//   <conversationId>.jsonl — append-only event log (every claude stream-json line)
// The conversationId IS the claude --session-id value, so resume works directly.

function convDir(dataDir) {
  return join(dataDir, 'conversations');
}

export async function ensureConvDir(dataDir) {
  const dir = convDir(dataDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function newConversationId() {
  return randomUUID();
}

export async function appendConversationIndex(dataDir, entry) {
  await ensureConvDir(dataDir);
  await appendFile(join(convDir(dataDir), 'index.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
}

export async function readConversationIndex(dataDir) {
  const path = join(convDir(dataDir), 'index.jsonl');
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  // Last write wins: a conversation may appear multiple times (rename/touch);
  // collapse to most recent entry per id.
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      byId.set(e.conversationId, { ...byId.get(e.conversationId), ...e });
    } catch {}
  }
  return Array.from(byId.values())
    .filter(e => !e.deleted)
    .sort((a, b) =>
      (b.lastMessageAt || b.createdAt || '').localeCompare(a.lastMessageAt || a.createdAt || '')
    );
}

export async function appendConversationEvent(dataDir, conversationId, event) {
  await ensureConvDir(dataDir);
  await appendFile(join(convDir(dataDir), `${conversationId}.jsonl`), JSON.stringify(event) + '\n', 'utf8');
}

export async function readConversationTranscript(dataDir, conversationId) {
  const path = join(convDir(dataDir), `${conversationId}.jsonl`);
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Derive a short title from the first user message (or fallback to date).
export function titleFromFirstMessage(text) {
  const t = String(text || '').trim().split('\n')[0].slice(0, 60);
  return t || 'New chat';
}

// Permission mode whitelist — anything outside this falls back to the default.
// We don't surface dontAsk/auto in the UI: dontAsk is mostly useless without
// an interactive prompt protocol, and auto is poorly documented.
export const PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'plan'];
export const DEFAULT_PERMISSION_MODE = 'acceptEdits';

export function normalizePermissionMode(mode) {
  return PERMISSION_MODES.includes(mode) ? mode : DEFAULT_PERMISSION_MODE;
}

// Model whitelist for the per-conversation picker. Aliases that claude CLI
// resolves to current versions. null = use whatever the CLI defaults to.
export const MODELS = ['opus', 'sonnet', 'haiku'];

export function normalizeModel(model) {
  if (!model) return null;
  return MODELS.includes(model) ? model : null;
}

// Walk a transcript and compute cumulative cost + token usage. Returns
// { costUsd, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens, turns }.
// Costs come straight from claude's result events (already includes cache
// economics priced in).
export function computeUsage(transcript) {
  let costUsd = 0;
  let tokensIn = 0, tokensOut = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
  let turns = 0;
  for (const ev of transcript || []) {
    if (ev.type !== 'result') continue;
    turns++;
    if (typeof ev.total_cost_usd === 'number') costUsd += ev.total_cost_usd;
    if (ev.usage) {
      tokensIn += ev.usage.input_tokens || 0;
      tokensOut += ev.usage.output_tokens || 0;
      cacheReadTokens += ev.usage.cache_read_input_tokens || 0;
      cacheCreationTokens += ev.usage.cache_creation_input_tokens || 0;
    }
  }
  return { costUsd, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens, turns };
}
