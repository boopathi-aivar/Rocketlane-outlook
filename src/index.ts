import type { ScheduledHandler } from 'aws-lambda';
import { loadConfig, getRocketlaneApiKey } from './config';
import { RocketlaneClient } from './rocketlane';
import { reconcileStatusHistory } from './statusHistory';
import { renderSummaryChart } from './chart';
import { renderHtml, renderPlainText } from './render';
import { sendEmail } from './send';
import type { FlaggedProject, RenderInput, RocketlaneProject } from './types';

const CHART_CID = 'summary-chart@rocketlane';
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export const handler: ScheduledHandler = async () => {
  const now = new Date();
  console.log('Job started', { runAt: now.toISOString() });

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

  const chartPng = await renderSummaryChart(blocked.length, delayed.length);

  const renderData: RenderInput = {
    blocked,
    delayed,
    totalCount: flagged.length,
    dayThreshold: config.dayThreshold,
    reportDate,
    chartCid: CHART_CID,
    hasChart: chartPng !== null,
  };

  const html = await renderHtml(
    config.templateBucket,
    config.templateKey,
    renderData,
  );
  const text = renderPlainText(renderData);

  const subject = buildSubject(blocked.length, delayed.length, reportDate);

  const messageId = await sendEmail({
    sender: config.sender,
    recipients: config.recipients,
    subject,
    html,
    text,
    chartPng,
    chartCid: CHART_CID,
  });

  console.log('Email sent', {
    messageId,
    blocked: blocked.length,
    delayed: delayed.length,
    recipients: config.recipients.length,
  });
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
