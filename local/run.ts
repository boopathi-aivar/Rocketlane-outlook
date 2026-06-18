/**
 * Local runner — no AWS required.
 *
 * Bypasses:  SSM → env vars
 *            Secrets Manager → ROCKETLANE_API_KEY env var
 *            S3  → reads templates/status-email.html from disk
 *            DynamoDB → local JSON file (local/output/.history.json)
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
import { renderSummaryChart, renderRoleStackedChart } from '../src/chart';
import { renderPlainText } from '../src/render';
import { reconcileLocalHistory } from './history';
import type {
  FlaggedProject,
  RenderInput,
  RoleBucket,
} from '../src/types';

loadDotEnv(resolve(__dirname, '.env'));

const LOGO_CID = 'aivar-logo@aivar';
const SUMMARY_CID = 'summary-chart@rocketlane';
const DM_CID = 'dm-chart@rocketlane';
const CSM_CID = 'csm-chart@rocketlane';
const AM_CID = 'am-chart@rocketlane';
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

  // Mirror prod: prefer API's statusUpdatedAt, else fall back to the locally-tracked
  // JSON history file (analogue of the DynamoDB table used in production).
  const sinceMap = reconcileLocalHistory(projects, now);

  const flagged: FlaggedProject[] = projects.map((p) => {
    const sinceIso = p.statusUpdatedAt ?? sinceMap.get(p.id) ?? now.toISOString();
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
  const preSales = flagged.filter((p) => p.currentPhase === 'Pre-Sales');
  const delivery = flagged.filter((p) => p.currentPhase === 'Delivery');

  const reportDate = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const bucket = (key: (p: FlaggedProject) => string): RoleBucket[] => {
    const map = new Map<string, RoleBucket>();
    for (const p of flagged) {
      const label = (key(p) || 'Unassigned').trim() || 'Unassigned';
      let b = map.get(label);
      if (!b) {
        b = { label, blocked: 0, delayed: 0 };
        map.set(label, b);
      }
      if (p.status === 'BLOCKED') b.blocked++;
      else if (p.status === 'DELAYED') b.delayed++;
    }
    return Array.from(map.values());
  };

  const [summaryPng, dmPng, csmPng, amPng] = await Promise.all([
    renderSummaryChart(blocked.length, delayed.length),
    renderRoleStackedChart(bucket((p) => p.deliveryManager), 'Workload by Delivery Manager'),
    renderRoleStackedChart(bucket((p) => p.csm), 'Workload by CSM'),
    renderRoleStackedChart(bucket((p) => p.accountManager), 'Workload by Account Manager'),
  ]);

  // Logo: read from disk instead of S3 in local mode.
  const logoPath = resolve(__dirname, '..', 'templates', 'assets', 'aivar-logo.png');
  const logoPng = existsSync(logoPath) ? readFileSync(logoPath) : null;

  const renderData: RenderInput = {
    blocked,
    delayed,
    preSales,
    delivery,
    totalCount: flagged.length,
    dayThreshold,
    reportDate,
    logoCid: LOGO_CID,
    hasLogo: logoPng !== null,
    summaryChartCid: SUMMARY_CID,
    hasSummaryChart: summaryPng !== null,
    dmChartCid: DM_CID,
    hasDmChart: dmPng !== null,
    csmChartCid: CSM_CID,
    hasCsmChart: csmPng !== null,
    amChartCid: AM_CID,
    hasAmChart: amPng !== null,
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

  if (summaryPng) writeFileSync(resolve(OUT_DIR, 'chart.png'), summaryPng);
  if (dmPng) writeFileSync(resolve(OUT_DIR, 'chart-dm.png'), dmPng);
  if (csmPng) writeFileSync(resolve(OUT_DIR, 'chart-csm.png'), csmPng);
  if (amPng) writeFileSync(resolve(OUT_DIR, 'chart-am.png'), amPng);

  // Build a browser-viewable preview that inlines all chart PNGs as data URIs,
  // since cid: references only resolve inside email clients.
  const inlineMap: Record<string, Buffer | null> = {
    [LOGO_CID]: logoPng,
    [SUMMARY_CID]: summaryPng,
    [DM_CID]: dmPng,
    [CSM_CID]: csmPng,
    [AM_CID]: amPng,
  };
  let preview = html;
  for (const [cid, png] of Object.entries(inlineMap)) {
    if (!png) continue;
    const uri = `data:image/png;base64,${png.toString('base64')}`;
    preview = preview.split(`cid:${cid}`).join(uri);
  }
  writeFileSync(resolve(OUT_DIR, 'email-preview.html'), preview, 'utf-8');

  console.log(`HTML        → ${htmlOut}`);
  console.log(`Preview     → ${resolve(OUT_DIR, 'email-preview.html')}`);
  console.log(`Text        → ${textOut}`);
  console.log('Done', {
    blocked: blocked.length,
    delayed: delayed.length,
    urgent: flagged.filter((p) => p.isUrgent).length,
    charts: [summaryPng, dmPng, csmPng, amPng].filter(Boolean).length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
