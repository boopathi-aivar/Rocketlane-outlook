import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const sns = new SNSClient({});

export interface AlertInput {
  stage: 'send' | 'job';
  error: unknown;
  context?: Record<string, unknown>;
}

const ALERTED_FLAG = Symbol.for('rocketlane.adminAlertPublished');

export function markAlerted(error: unknown): void {
  if (error && typeof error === 'object') {
    (error as Record<symbol, unknown>)[ALERTED_FLAG] = true;
  }
}

export function isAlerted(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as Record<symbol, unknown>)[ALERTED_FLAG],
  );
}

export async function publishAdminAlert(input: AlertInput): Promise<void> {
  if (isAlerted(input.error)) return;
  const topicArn = process.env.ADMIN_ALERT_TOPIC_ARN;
  if (!topicArn) {
    console.warn('ADMIN_ALERT_TOPIC_ARN not set; skipping admin alert publish');
    return;
  }

  const err = input.error;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'rocketlane-status-email';

  const subject = truncate(
    `[Rocketlane Status Email] ${input.stage === 'send' ? 'Email send failed' : 'Job failed'}: ${message}`,
    100,
  );

  const body = JSON.stringify(
    {
      function: functionName,
      stage: input.stage,
      error: message,
      stack,
      context: input.context ?? {},
      occurredAt: new Date().toISOString(),
    },
    null,
    2,
  );

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject,
      Message: body,
    }),
  );
  markAlerted(input.error);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
