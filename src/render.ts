import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import Handlebars from 'handlebars';
import type { FlaggedProject, RenderInput } from './types';

const s3 = new S3Client({});

let templateCache: HandlebarsTemplateDelegate | null = null;
let templateEtag: string | null = null;
let logoCache: Buffer | null = null;
let logoEtag: string | null = null;

Handlebars.registerHelper('formatDate', (iso: unknown) => {
  if (!iso || typeof iso !== 'string') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
});

Handlebars.registerHelper('gt', (a: number, b: number) => a > b);

async function loadTemplate(
  bucket: string,
  key: string,
): Promise<HandlebarsTemplateDelegate> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (templateCache && res.ETag && res.ETag === templateEtag) {
    return templateCache;
  }
  const body = await res.Body!.transformToString('utf-8');
  templateCache = Handlebars.compile(body, { noEscape: false });
  templateEtag = res.ETag ?? null;
  return templateCache;
}

export async function renderHtml(
  bucket: string,
  key: string,
  data: RenderInput,
): Promise<string> {
  const template = await loadTemplate(bucket, key);
  return template(data);
}

export async function loadLogo(
  bucket: string,
  key: string,
): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (logoCache && res.ETag && res.ETag === logoEtag) {
      return logoCache;
    }
    const bytes = await res.Body!.transformToByteArray();
    logoCache = Buffer.from(bytes);
    logoEtag = res.ETag ?? null;
    return logoCache;
  } catch (err) {
    console.warn(`Logo not found at s3://${bucket}/${key} — skipping`, err);
    return null;
  }
}

export function renderPlainText(data: RenderInput): string {
  const lines: string[] = [];
  lines.push(`Rocketlane Project Status Report — ${data.reportDate}`);
  lines.push('='.repeat(64));
  lines.push('');

  if (data.totalCount === 0) {
    lines.push('No projects are currently blocked or delayed. All clear.');
    return lines.join('\n');
  }

  lines.push(
    `Blocked: ${data.blocked.length}    Delayed: ${data.delayed.length}    ` +
      `Threshold for urgent: ${data.dayThreshold} day(s)`,
  );
  lines.push('');

  const section = (title: string, items: FlaggedProject[]) => {
    if (items.length === 0) return;
    lines.push(`-- ${title} (${items.length}) --`);
    for (const p of items) {
      const urgent = p.isUrgent ? ' [URGENT]' : '';
      lines.push(`* ${p.name}${urgent}`);
      lines.push(`  Days in status: ${p.daysInStatus}`);
      lines.push(`  Owner: ${p.owner}`);
      lines.push(`  Delivery Manager: ${p.deliveryManager}`);
      lines.push(`  CSM: ${p.csm}`);
      lines.push(`  Account Manager: ${p.accountManager}`);
      lines.push(`  Action Item: ${p.reason || '—'}`);
      lines.push(
        `  Last updated: ${new Date(p.lastUpdatedAt).toLocaleDateString('en-US')}`,
      );
      lines.push(`  Link: ${p.url}`);
      lines.push('');
    }
  };

  section('BLOCKED', data.blocked);
  section('DELAYED', data.delayed);

  lines.push('— Automated by AIVAR Delivery.');
  return lines.join('\n');
}
