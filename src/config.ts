import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { AppConfig } from './types';

const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

const PARAM_PREFIX = process.env.PARAM_PREFIX ?? '/rocketlane-status-email/prod';
const SECRET_ID = process.env.ROCKETLANE_SECRET_ID ?? 'rocketlane/api-key';
const GRAPH_SECRET_ID = process.env.GRAPH_SECRET_ID ?? 'rocketlane/graph-credentials';

let cachedConfig: AppConfig | null = null;
let cachedApiKey: string | null = null;
let cachedGraphCreds: { tenantId: string; clientId: string; clientSecret: string } | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;

  const [params, graphCreds] = await Promise.all([
    fetchSsmParams(),
    loadGraphCredentials(),
  ]);

  const required = (key: string): string => {
    const v = params.get(key);
    if (v === undefined || v === '') {
      throw new Error(`Missing required SSM parameter: ${PARAM_PREFIX}/${key}`);
    }
    return v;
  };
  const optional = (key: string, fallback: string): string =>
    params.get(key) ?? fallback;

  cachedConfig = {
    dayThreshold: parseInt(optional('day_threshold', '7'), 10),
    recipients: required('recipients')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sender: required('sender'),
    rocketlaneBaseUrl: optional(
      'rocketlane_base_url',
      'https://api.rocketlane.com/api/1.0',
    ),
    templateBucket: required('template_bucket'),
    templateKey: optional('template_key', 'templates/status-email.html'),
    logoKey: optional('logo_key', 'templates/assets/aivar-logo.png'),
    historyTableName: optional('history_table_name', ''),
    useHistoryTable: optional('use_history_table', 'false') === 'true',
    graphTenantId: graphCreds.tenantId,
    graphClientId: graphCreds.clientId,
    graphClientSecret: graphCreds.clientSecret,
  };

  return cachedConfig;
}

async function fetchSsmParams(): Promise<Map<string, string>> {
  const params = new Map<string, string>();
  let nextToken: string | undefined;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: PARAM_PREFIX,
        Recursive: false,
        WithDecryption: true,
        NextToken: nextToken,
      }),
    );
    for (const p of res.Parameters ?? []) {
      if (p.Name && p.Value !== undefined) {
        const key = p.Name.slice(PARAM_PREFIX.length + 1);
        params.set(key, p.Value);
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return params;
}

export async function loadGraphCredentials(): Promise<{ tenantId: string; clientId: string; clientSecret: string }> {
  if (cachedGraphCreds) return cachedGraphCreds;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: GRAPH_SECRET_ID }));
  if (!res.SecretString) throw new Error(`Secret ${GRAPH_SECRET_ID} has no SecretString value`);
  const parsed = JSON.parse(res.SecretString);
  cachedGraphCreds = {
    tenantId: parsed.tenant_id,
    clientId: parsed.client_id,
    clientSecret: parsed.client_secret,
  };
  return cachedGraphCreds;
}

export async function getRocketlaneApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: SECRET_ID }),
  );
  if (!res.SecretString) {
    throw new Error(`Secret ${SECRET_ID} has no SecretString value`);
  }
  cachedApiKey = res.SecretString;
  return cachedApiKey;
}
