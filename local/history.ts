/**
 * Local JSON-file analogue of the production DynamoDB status-history table.
 * Used by both local/run.ts and local/send.ts so days-in-status is consistent
 * between preview and actual send.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { RocketlaneProject } from '../src/types';

interface HistoryRecord {
  status: string;
  statusSince: string;
}

const OUT_DIR = resolve(__dirname, 'output');
const HISTORY_PATH = resolve(OUT_DIR, '.history.json');

function loadHistory(): Map<string, HistoryRecord> {
  if (!existsSync(HISTORY_PATH)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(HISTORY_PATH, 'utf-8')) as Record<
      string,
      HistoryRecord
    >;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function saveHistory(history: Map<string, HistoryRecord>): void {
  const obj: Record<string, HistoryRecord> = {};
  for (const [k, v] of history) obj[k] = v;
  const dir = dirname(HISTORY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(obj, null, 2), 'utf-8');
}

export function reconcileLocalHistory(
  projects: RocketlaneProject[],
  now: Date,
): Map<string, string> {
  const history = loadHistory();
  const sinceMap = new Map<string, string>();
  const seenNow = new Set<string>();

  for (const p of projects) {
    seenNow.add(p.id);
    const prior = history.get(p.id);
    if (prior && prior.status === p.status) {
      sinceMap.set(p.id, prior.statusSince);
    } else {
      const since = now.toISOString();
      history.set(p.id, { status: p.status, statusSince: since });
      sinceMap.set(p.id, since);
    }
  }

  for (const id of Array.from(history.keys())) {
    if (!seenNow.has(id)) history.delete(id);
  }

  saveHistory(history);
  return sinceMap;
}
