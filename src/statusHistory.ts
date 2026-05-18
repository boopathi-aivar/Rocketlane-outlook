import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { RocketlaneProject } from './types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface HistoryRecord {
  projectId: string;
  status: string;
  statusSince: string;
  lastSeen: string;
}

export async function reconcileStatusHistory(
  tableName: string,
  projects: RocketlaneProject[],
  now: Date,
): Promise<Map<string, string>> {
  if (projects.length === 0) return new Map();

  const keys = projects.map((p) => ({ projectId: p.id }));
  const existing = new Map<string, HistoryRecord>();

  for (const batch of chunk(keys, 100)) {
    const res = await ddb.send(
      new BatchGetCommand({ RequestItems: { [tableName]: { Keys: batch } } }),
    );
    for (const item of res.Responses?.[tableName] ?? []) {
      const rec = item as HistoryRecord;
      existing.set(rec.projectId, rec);
    }
  }

  const result = new Map<string, string>();
  const writes: { PutRequest: { Item: HistoryRecord } }[] = [];

  for (const project of projects) {
    const prior = existing.get(project.id);
    let statusSince: string;

    if (project.statusUpdatedAt) {
      statusSince = project.statusUpdatedAt;
    } else if (prior && prior.status === project.status) {
      statusSince = prior.statusSince;
    } else {
      statusSince = now.toISOString();
    }

    result.set(project.id, statusSince);

    const needsWrite =
      !prior ||
      prior.status !== project.status ||
      prior.statusSince !== statusSince;

    if (needsWrite) {
      writes.push({
        PutRequest: {
          Item: {
            projectId: project.id,
            status: project.status,
            statusSince,
            lastSeen: now.toISOString(),
          },
        },
      });
    }
  }

  for (const batch of chunk(writes, 25)) {
    await ddb.send(
      new BatchWriteCommand({ RequestItems: { [tableName]: batch } }),
    );
  }

  return result;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
