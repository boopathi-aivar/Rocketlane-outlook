import axios from 'axios';
import { publishAdminAlert } from './alert';
import { getAccessToken, type GraphCreds } from './graphAuth';

export interface InlineImage {
  cid: string;
  png: Buffer;
  filename: string;
}

export interface SendInput {
  sender: string;
  recipients: string[];
  subject: string;
  html: string;
  text: string;
  inlineImages: InlineImage[];
  creds: GraphCreds;
  threadMessageId?: string; // stored Exchange internetMessageId; absent on first send
}

// Returns { requestId, ownMessageId }
// ownMessageId: the Message-ID we set on this email (store it on first send as the thread root).
export async function sendEmail(input: SendInput): Promise<{ requestId: string; ownMessageId: string }> {
  const isReply = !!input.threadMessageId;

  // Generate a stable Message-ID for this email
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 10);
  const ownMessageId = `<rl-status-${ts}-${rand}@aivar.tech>`;

  const raw = buildMime(input, isReply, ownMessageId);
  const b64 = Buffer.from(raw, 'utf-8').toString('base64');

  try {
    const token = await getAccessToken(input.creds);
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(input.sender)}`;

    const res = await axios.post(`${base}/sendMail`, b64, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      timeout: 30000,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const requestId =
      (res.headers?.['request-id'] as string | undefined) ??
      (res.headers?.['x-ms-ags-diagnostic'] as string | undefined) ??
      '';

    return { requestId, ownMessageId };
  } catch (error: any) {
    const detail = error?.response?.data ?? error?.message ?? String(error);
    console.error('Microsoft Graph send failed', detail);
    try {
      await publishAdminAlert({
        stage: 'send',
        error,
        context: {
          sender: input.sender,
          recipientCount: input.recipients.length,
          subject: input.subject,
          attachmentCount: input.inlineImages.length,
          graphResponse: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 1000),
        },
      });
    } catch (alertErr) {
      console.error('Failed to publish admin alert for send failure', alertErr);
    }
    throw error;
  }
}

function buildMime(input: SendInput, isReply: boolean, ownMessageId: string): string {
  const mixedBoundary = `mixed_${randomBoundary()}`;
  const altBoundary = `alt_${randomBoundary()}`;
  const relatedBoundary = `rel_${randomBoundary()}`;

  const headers: string[] = [
    `From: ${input.sender}`,
    `To: ${input.recipients.join(', ')}`,
    `Subject: ${encodeSubject(isReply ? `Re: ${input.subject}` : input.subject)}`,
    `Message-ID: ${ownMessageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
  ];

  if (isReply && input.threadMessageId) {
    headers.push(`In-Reply-To: ${input.threadMessageId}`);
    headers.push(`References: ${input.threadMessageId}`);
  }

  const body: string[] = [];
  body.push(`--${mixedBoundary}`);
  body.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
  body.push('');
  body.push(`--${relatedBoundary}`);
  body.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  body.push('');

  body.push(`--${altBoundary}`);
  body.push('Content-Type: text/plain; charset=UTF-8');
  body.push('Content-Transfer-Encoding: 7bit');
  body.push('');
  body.push(input.text);
  body.push('');

  body.push(`--${altBoundary}`);
  body.push('Content-Type: text/html; charset=UTF-8');
  body.push('Content-Transfer-Encoding: 7bit');
  body.push('');
  body.push(input.html);
  body.push('');
  body.push(`--${altBoundary}--`);

  for (const img of input.inlineImages) {
    body.push(`--${relatedBoundary}`);
    body.push('Content-Type: image/png');
    body.push('Content-Transfer-Encoding: base64');
    body.push(`Content-ID: <${img.cid}>`);
    body.push(`Content-Disposition: inline; filename="${img.filename}"`);
    body.push('');
    body.push(img.png.toString('base64'));
    body.push('');
  }

  body.push(`--${relatedBoundary}--`);
  body.push(`--${mixedBoundary}--`);

  return [...headers, '', ...body].join('\r\n');
}

function randomBoundary(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}
