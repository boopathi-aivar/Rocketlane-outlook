/**
 * Local Microsoft Graph send.
 *
 * Builds the same email as `npm run local-run` then actually sends it via
 * Microsoft Graph using the credentials in local/.env. By design this is a
 * separate script from local-run so dev iterations don't accidentally fire
 * real emails.
 *
 * Usage:
 *   # Default recipient comes from TEST_RECIPIENT in local/.env:
 *   npm run local-send
 *
 *   # Override / supply the recipient:
 *   npm run local-send -- --to you@aivar.tech
 *
 *   # Multiple recipients (comma-separated):
 *   npm run local-send -- --to you@aivar.tech,other@aivar.tech
 *
 *   # Dry-run (build the MIME and print the size, but don't send):
 *   npm run local-send -- --to you@aivar.tech --dry-run
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Handlebars from 'handlebars';
import { RocketlaneClient } from '../src/rocketlane';
import { renderSummaryChart, renderRoleStackedChart } from '../src/chart';
import { renderPlainText } from '../src/render';
import { sendEmail, type InlineImage } from '../src/send';
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

function parseArgs(argv: string[]): { to: string[]; dryRun: boolean } {
  let to = '';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--to' && argv[i + 1]) {
      to = argv[i + 1]!;
      i++;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }
  if (!to) to = process.env.TEST_RECIPIENT ?? '';
  const recipients = to
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { to: recipients, dryRun };
}

async function main(): Promise<void> {
  const now = new Date();
  const { to, dryRun } = parseArgs(process.argv.slice(2));

  if (to.length === 0) {
    console.error(
      'ERROR: No recipient. Pass --to addr@example.com or set TEST_RECIPIENT in local/.env',
    );
    process.exit(1);
  }

  const apiKey = requireEnv('ROCKETLANE_API_KEY');
  const tenantId = requireEnv('GRAPH_TENANT_ID');
  const clientId = requireEnv('GRAPH_CLIENT_ID');
  const clientSecret = requireEnv('GRAPH_CLIENT_SECRET');
  const sender = requireEnv('GRAPH_SENDER');
  const baseUrl =
    process.env.ROCKETLANE_BASE_URL ?? 'https://api.rocketlane.com/api/1.0';
  const dayThreshold = parseInt(process.env.DAY_THRESHOLD ?? '7', 10);

  console.log('Building email', { sender, recipients: to, dryRun });

  const client = new RocketlaneClient(baseUrl, apiKey);
  const projects = await client.fetchFlaggedProjects();
  console.log(`Fetched ${projects.length} flagged project(s)`);

  // Use the same JSON-file history stub as local/run.ts so days-in-status
  // matches the preview and the URGENT badge fires correctly.
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

  const logoPath = resolve(__dirname, '..', 'templates', 'assets', 'aivar-logo.png');
  const logoPng = existsSync(logoPath) ? readFileSync(logoPath) : null;

  const renderData: RenderInput = {
    blocked,
    delayed,
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

  const templatePath = resolve(__dirname, '..', 'templates', 'status-email.html');
  const templateSrc = readFileSync(templatePath, 'utf-8');
  // Importing renderPlainText already registered the Handlebars helpers.
  const template = Handlebars.compile(templateSrc, { noEscape: false });
  const html = template(renderData);
  const text = renderPlainText(renderData);

  const subject =
    blocked.length === 0 && delayed.length === 0
      ? `Rocketlane status — All clear (${reportDate})`
      : `Rocketlane status — ${blocked.length} blocked, ${delayed.length} delayed (${reportDate})`;

  const inlineImages: InlineImage[] = [];
  if (logoPng) inlineImages.push({ cid: LOGO_CID, png: logoPng, filename: 'aivar-logo.png' });
  if (summaryPng) inlineImages.push({ cid: SUMMARY_CID, png: summaryPng, filename: 'summary.png' });
  if (dmPng) inlineImages.push({ cid: DM_CID, png: dmPng, filename: 'by-delivery-manager.png' });
  if (csmPng) inlineImages.push({ cid: CSM_CID, png: csmPng, filename: 'by-csm.png' });
  if (amPng) inlineImages.push({ cid: AM_CID, png: amPng, filename: 'by-account-manager.png' });

  if (dryRun) {
    console.log('DRY RUN — not calling Graph');
    console.log({
      sender,
      recipients: to,
      subject,
      attachments: inlineImages.length,
      htmlBytes: html.length,
      textBytes: text.length,
    });
    return;
  }

  console.log('Sending via Microsoft Graph…');
  const requestId = await sendEmail({
    sender,
    recipients: to,
    subject,
    html,
    text,
    inlineImages,
    creds: { tenantId, clientId, clientSecret },
  });

  console.log('Sent.', {
    requestId,
    blocked: blocked.length,
    delayed: delayed.length,
    recipients: to,
  });
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
