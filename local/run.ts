/**
 * Local runner — no AWS required.
 *
 * Bypasses:  SSM → env vars
 *            Secrets Manager → ROCKETLANE_API_KEY env var
 *            S3  → reads templates/status-email.html from disk
 *            DynamoDB → skipped (uses statusUpdatedAt from API or defaults to today)
 *            SES → writes local/output/email.html + email.txt instead of sending
 *
 * Usage:
 *   cp local/.env.example local/.env   # fill in your API key
 *   npm run local-run
 *   open local/output/email.html
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Handlebars from 'handlebars';
import { RocketlaneClient } from '../src/rocketlane';
import { renderSummaryChart } from '../src/chart';
import { renderPlainText } from '../src/render';
import type { FlaggedProject, RenderInput } from '../src/types';

loadDotEnv(resolve(__dirname, '.env'));

const CHART_CID = 'summary-chart@rocketlane';
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const OUT_DIR = resolve(__dirname, 'output');

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
    console.error(`       Copy local/.env.example to local/.env and fill it in.`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const now = new Date();

  const apiKey = requireEnv('ROCKETLANE_API_KEY');
  const baseUrl =
    process.env.ROCKETLANE_BASE_URL ?? 'https://api.rocketlane.com/api/1.0';
  const dayThreshold = parseInt(process.env.DAY_THRESHOLD ?? '7', 10);

  console.log('Local run started', { runAt: now.toISOString(), baseUrl, dayThreshold });

  const client = new RocketlaneClient(baseUrl, apiKey);
  const projects = await client.fetchFlaggedProjects();
  console.log(`Fetched ${projects.length} flagged project(s)`);

  // No DynamoDB — use statusUpdatedAt from the API response, or fall back to now
  const flagged: FlaggedProject[] = projects.map((p) => {
    const sinceIso = p.statusUpdatedAt ?? now.toISOString();
    const since = new Date(sinceIso);
    const sinceMs = Number.isNaN(since.getTime()) ? now.getTime() : since.getTime();
    const daysInStatus = Math.max(0, Math.floor((now.getTime() - sinceMs) / MS_PER_DAY));
    return { ...p, daysInStatus, isUrgent: daysInStatus >= dayThreshold };
  });

  flagged.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'BLOCKED' ? -1 : 1;
    return b.daysInStatus - a.daysInStatus;
  });

  const blocked = flagged.filter((p) => p.status === 'BLOCKED');
  const delayed = flagged.filter((p) => p.status === 'DELAYED');

  const reportDate = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const chartPng = await renderSummaryChart(blocked.length, delayed.length);

  const renderData: RenderInput = {
    blocked,
    delayed,
    totalCount: flagged.length,
    dayThreshold,
    reportDate,
    chartCid: CHART_CID,
    hasChart: chartPng !== null,
  };

  // Load template from local filesystem instead of S3.
  // Importing renderPlainText above also registers the Handlebars helpers (formatDate, gt).
  const templatePath = resolve(__dirname, '..', 'templates', 'status-email.html');
  const templateSrc = readFileSync(templatePath, 'utf-8');
  const template = Handlebars.compile(templateSrc, { noEscape: false });
  const html = template(renderData);
  const text = renderPlainText(renderData);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const htmlOut = resolve(OUT_DIR, 'email.html');
  const textOut = resolve(OUT_DIR, 'email.txt');
  writeFileSync(htmlOut, html, 'utf-8');
  writeFileSync(textOut, text, 'utf-8');

  if (chartPng) {
    const chartOut = resolve(OUT_DIR, 'chart.png');
    writeFileSync(chartOut, chartPng);
    console.log(`Chart  → ${chartOut}`);
  }

  console.log(`HTML   → ${htmlOut}`);
  console.log(`Text   → ${textOut}`);
  console.log('Done', {
    blocked: blocked.length,
    delayed: delayed.length,
    urgent: flagged.filter((p) => p.isUrgent).length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
