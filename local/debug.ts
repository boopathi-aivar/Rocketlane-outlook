/**
 * Dumps the raw Rocketlane API response for the first page of DELAYED projects.
 * Run this to inspect the actual field names and fix the normalize() mapping.
 *
 * Usage:
 *   npm run local-debug
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import axios from 'axios';

loadDotEnv(resolve(__dirname, '.env'));

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`ERROR: Missing required env var: ${key}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const apiKey = requireEnv('ROCKETLANE_API_KEY');
  const baseUrl =
    process.env.ROCKETLANE_BASE_URL ?? 'https://api.rocketlane.com/api/1.0';

  const http = axios.create({
    baseURL: baseUrl,
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  console.log(`Fetching from ${baseUrl}/projects ...\n`);

  for (const status of ['BLOCKED', 'DELAYED'] as const) {
    let response: unknown;
    try {
      const { data } = await http.get('/projects', {
        params: { 'projectStatus.eq': status, pageSize: 1 },
      });
      response = data;
    } catch (err: any) {
      console.error(`Failed to fetch ${status} projects:`, err?.response?.data ?? err?.message);
      continue;
    }

    const data = response as Record<string, any>;
    const items: unknown[] =
      data?.data ?? data?.projects ?? data?.items ?? [];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`STATUS: ${status}  —  top-level response keys:`);
    console.log(Object.keys(data));

    if (items.length === 0) {
      console.log(`  (no ${status} projects found)`);
      continue;
    }

    const first = items[0] as Record<string, any>;
    console.log(`\nFirst project raw shape (all keys + values):`);
    console.log(JSON.stringify(first, null, 2));

    // Highlight the fields our normalize() currently looks for
    const checks: Record<string, unknown> = {
      'id candidates':         { projectId: first['projectId'], id: first['id'] },
      'name candidates':       { projectName: first['projectName'], name: first['name'] },
      'status candidates':     { projectStatus: first['projectStatus'], status: first['status'] },
      'owner candidates':      { 'owner.name': first['owner']?.name, 'projectOwner.name': first['projectOwner']?.name, ownerName: first['ownerName'] },
      'reason candidates':     { statusReason: first['statusReason'], reason: first['reason'], 'projectStatus.reason': first['projectStatus']?.reason },
      'statusUpdatedAt candidates': { statusUpdatedAt: first['statusUpdatedAt'], statusLastChangedAt: first['statusLastChangedAt'], 'projectStatus.updatedAt': first['projectStatus']?.updatedAt, 'projectStatus.lastUpdatedAt': first['projectStatus']?.lastUpdatedAt },
      'lastUpdatedAt candidates':   { updatedAt: first['updatedAt'], lastUpdatedAt: first['lastUpdatedAt'] },
      'url candidates':        { projectUrl: first['projectUrl'] },
    };

    console.log('\nField mapping check (undefined = not found, fix needed):');
    for (const [label, vals] of Object.entries(checks)) {
      const found = Object.entries(vals as Record<string, unknown>).find(([, v]) => v !== undefined);
      const status = found ? `✓  "${found[0]}" = ${JSON.stringify(found[1])}` : '✗  NONE FOUND — needs fix';
      console.log(`  ${label.padEnd(30)} ${status}`);
    }
  }

  // Also save full raw response to output/
  const outDir = resolve(__dirname, 'output');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  for (const status of ['BLOCKED', 'DELAYED'] as const) {
    try {
      const { data } = await http.get('/projects', {
        params: { 'projectStatus.eq': status, pageSize: 5 },
      });
      const outPath = resolve(outDir, `raw-${status.toLowerCase()}.json`);
      writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`\nFull raw response saved → ${outPath}`);
    } catch {
      // already logged above
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
