/**
 * Seeds the DynamoDB status-history table from the local .history.json file.
 * Run once after a fresh deploy to avoid day-0 showing for all projects.
 *
 * Usage:
 *   AWS_PROFILE=<profile> AWS_REGION=us-east-1 \
 *   TABLE_NAME=rocketlane-status-history-prod \
 *   npx ts-node scripts/seed-history.ts
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TABLE_NAME = process.env.TABLE_NAME;
if (!TABLE_NAME) {
  console.error('ERROR: TABLE_NAME env var required');
  process.exit(1);
}

const HISTORY_PATH = resolve(__dirname, '../local/output/.history.json');
if (!existsSync(HISTORY_PATH)) {
  console.error('ERROR: Local history file not found at', HISTORY_PATH);
  process.exit(1);
}

const history = JSON.parse(readFileSync(HISTORY_PATH, 'utf-8')) as Record<
  string,
  { status: string; statusSince: string }
>;

const now = new Date().toISOString();
const items = Object.entries(history).map(([projectId, rec]) => ({
  PutRequest: {
    Item: {
      projectId,
      status: rec.status,
      statusSince: rec.statusSince,
      lastSeen: now,
    },
  },
}));

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log(`Seeding ${items.length} records into ${TABLE_NAME}...`);
  for (const batch of chunk(items, 25)) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE_NAME as string]: batch } }));
  }
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
