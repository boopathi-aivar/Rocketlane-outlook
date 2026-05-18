import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({});

export interface SendInput {
  sender: string;
  recipients: string[];
  subject: string;
  html: string;
  text: string;
  chartPng: Buffer | null;
  chartCid: string;
}

export async function sendEmail(input: SendInput): Promise<string> {
  const mixedBoundary = `mixed_${randomBoundary()}`;
  const altBoundary = `alt_${randomBoundary()}`;
  const relatedBoundary = `rel_${randomBoundary()}`;

  const headers: string[] = [
    `From: ${input.sender}`,
    `To: ${input.recipients.join(', ')}`,
    `Subject: ${encodeSubject(input.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
  ];

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

  if (input.chartPng) {
    body.push(`--${relatedBoundary}`);
    body.push('Content-Type: image/png');
    body.push('Content-Transfer-Encoding: base64');
    body.push(`Content-ID: <${input.chartCid}>`);
    body.push('Content-Disposition: inline; filename="summary.png"');
    body.push('');
    body.push(input.chartPng.toString('base64'));
    body.push('');
  }

  body.push(`--${relatedBoundary}--`);
  body.push(`--${mixedBoundary}--`);

  const raw = [...headers, '', ...body].join('\r\n');

  const res = await ses.send(
    new SendRawEmailCommand({
      Source: input.sender,
      Destinations: input.recipients,
      RawMessage: { Data: Buffer.from(raw, 'utf-8') },
    }),
  );

  return res.MessageId ?? '';
}

function randomBoundary(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}
