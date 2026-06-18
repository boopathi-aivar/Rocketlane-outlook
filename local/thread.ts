import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

interface LocalThreadRecord {
  internetMessageId: string;
}

const THREAD_PATH = resolve(__dirname, 'output', '.thread.json');

export function getLocalThreadMessageId(): string | undefined {
  if (!existsSync(THREAD_PATH)) return undefined;
  try {
    const rec = JSON.parse(readFileSync(THREAD_PATH, 'utf-8')) as LocalThreadRecord;
    return rec.internetMessageId || undefined;
  } catch {
    return undefined;
  }
}

export function saveLocalThreadMessageId(internetMessageId: string): void {
  const dir = dirname(THREAD_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(THREAD_PATH, JSON.stringify({ internetMessageId }, null, 2));
}
