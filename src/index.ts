import type { ScheduledHandler } from 'aws-lambda';
import { loadConfig, getRocketlaneApiKey } from './config';
import { RocketlaneClient } from './rocketlane';
import { reconcileStatusHistory } from './statusHistory';
import { renderSummaryChart, renderRoleStackedChart } from './chart';
import { renderHtml, renderPlainText, loadLogo } from './render';
import { sendEmail } from './send';
import { publishAdminAlert } from './alert';
import type {
  FlaggedProject,
  RenderInput,
  RocketlaneProject,
  RoleBucket,
} from './types';
import type { InlineImage } from './send';

const LOGO_CID = 'aivar-logo@aivar';
const SUMMARY_CID = 'summary-chart@rocketlane';
const DM_CID = 'dm-chart@rocketlane';
const CSM_CID = 'csm-chart@rocketlane';
const AM_CID = 'am-chart@rocketlane';
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export const handler: ScheduledHandler = async () => {
  const now = new Date();
  console.log('Job started', { runAt: now.toISOString() });

  try {
    const config = await loadConfig();
    const apiKey = await getRocketlaneApiKey();

    const client = new RocketlaneClient(config.rocketlaneBaseUrl, apiKey);
    const projects = await client.fetchFlaggedProjects();
    console.log(`Fetched ${projects.length} flagged project(s) from Rocketlane`);

    let statusSinceMap = new Map<string, string>();
    if (config.useHistoryTable && config.historyTableName) {
      statusSinceMap = await reconcileStatusHistory(
        config.historyTableName,
        projects,
        now,
      );
    }

    const flagged = projects.map((p) =>
      buildFlagged(p, statusSinceMap, config.dayThreshold, now),
    );

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

    const dmBuckets = bucketByRole(flagged, (p) => p.deliveryManager);
    const csmBuckets = bucketByRole(flagged, (p) => p.csm);
    const amBuckets = bucketByRole(flagged, (p) => p.accountManager);

    const [logoPng, summaryPng, dmPng, csmPng, amPng] = await Promise.all([
      loadLogo(config.templateBucket, config.logoKey),
      renderSummaryChart(blocked.length, delayed.length),
      renderRoleStackedChart(dmBuckets, 'Workload by Delivery Manager'),
      renderRoleStackedChart(csmBuckets, 'Workload by CSM'),
      renderRoleStackedChart(amBuckets, 'Workload by Account Manager'),
    ]);

    const renderData: RenderInput = {
      blocked,
      delayed,
      totalCount: flagged.length,
      dayThreshold: config.dayThreshold,
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

    const html = await renderHtml(
      config.templateBucket,
      config.templateKey,
      renderData,
    );
    const text = renderPlainText(renderData);

    const subject = buildSubject(blocked.length, delayed.length, reportDate);

    const inlineImages: InlineImage[] = [];
    if (logoPng) inlineImages.push({ cid: LOGO_CID, png: logoPng, filename: 'aivar-logo.png' });
    if (summaryPng) inlineImages.push({ cid: SUMMARY_CID, png: summaryPng, filename: 'summary.png' });
    if (dmPng) inlineImages.push({ cid: DM_CID, png: dmPng, filename: 'by-delivery-manager.png' });
    if (csmPng) inlineImages.push({ cid: CSM_CID, png: csmPng, filename: 'by-csm.png' });
    if (amPng) inlineImages.push({ cid: AM_CID, png: amPng, filename: 'by-account-manager.png' });

    const messageId = await sendEmail({
      sender: config.sender,
      recipients: config.recipients,
      subject,
      html,
      text,
      inlineImages,
      creds: {
        tenantId: config.graphTenantId,
        clientId: config.graphClientId,
        clientSecret: config.graphClientSecret,
      },
    });

    console.log('Email sent', {
      messageId,
      blocked: blocked.length,
      delayed: delayed.length,
      recipients: config.recipients.length,
      charts: inlineImages.length,
    });
  } catch (error) {
    console.error('Job failed', error);
    try {
      await publishAdminAlert({
        stage: 'job',
        error,
        context: { runAt: now.toISOString() },
      });
    } catch (alertErr) {
      console.error('Failed to publish admin alert for job failure', alertErr);
    }
    throw error;
  }
};

function buildFlagged(
  project: RocketlaneProject,
  statusSinceMap: Map<string, string>,
  dayThreshold: number,
  now: Date,
): FlaggedProject {
  const sinceIso =
    project.statusUpdatedAt ??
    statusSinceMap.get(project.id) ??
    now.toISOString();

  const since = new Date(sinceIso);
  const sinceMs = Number.isNaN(since.getTime()) ? now.getTime() : since.getTime();
  const daysInStatus = Math.max(
    0,
    Math.floor((now.getTime() - sinceMs) / MS_PER_DAY),
  );

  return {
    ...project,
    daysInStatus,
    isUrgent: daysInStatus >= dayThreshold,
  };
}

function bucketByRole(
  projects: FlaggedProject[],
  key: (p: FlaggedProject) => string,
): RoleBucket[] {
  const map = new Map<string, RoleBucket>();
  for (const p of projects) {
    const label = (key(p) || 'Unassigned').trim() || 'Unassigned';
    let bucket = map.get(label);
    if (!bucket) {
      bucket = { label, blocked: 0, delayed: 0 };
      map.set(label, bucket);
    }
    if (p.status === 'BLOCKED') bucket.blocked++;
    else if (p.status === 'DELAYED') bucket.delayed++;
  }
  return Array.from(map.values());
}

function buildSubject(
  blocked: number,
  delayed: number,
  reportDate: string,
): string {
  if (blocked === 0 && delayed === 0) {
    return `Rocketlane status — All clear (${reportDate})`;
  }
  return `Rocketlane status — ${blocked} blocked, ${delayed} delayed (${reportDate})`;
}
