import { readFile } from 'node:fs/promises';

export function extractPercents(cache) {
  if (!cache || typeof cache !== 'object') return null;
  if (cache.fiveHourLimit?.percentUsed != null && cache.weeklyLimit?.percentUsed != null) {
    return {
      fiveHourPercentUsed: cache.fiveHourLimit.percentUsed,
      weeklyPercentUsed: cache.weeklyLimit.percentUsed,
    };
  }
  if (cache.limits?.['5h']?.percent_used != null && cache.limits?.['7d']?.percent_used != null) {
    return {
      fiveHourPercentUsed: cache.limits['5h'].percent_used,
      weeklyPercentUsed: cache.limits['7d'].percent_used,
    };
  }
  return null;
}

export async function readUsage(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let cache;
  try {
    cache = JSON.parse(text);
  } catch {
    return null;
  }
  return extractPercents(cache);
}
