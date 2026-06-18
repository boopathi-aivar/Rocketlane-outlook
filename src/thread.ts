import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const THREAD_KEY = '__thread__';

interface ThreadRecord {
  projectId: string;
  internetMessageId: string;
}

export async function getThreadMessageId(tableName: string): Promise<string | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { projectId: THREAD_KEY } }),
  );
  const rec = res.Item as ThreadRecord | undefined;
  return rec?.internetMessageId || undefined;
}

export async function saveThreadMessageId(tableName: string, internetMessageId: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: { projectId: THREAD_KEY, internetMessageId } as ThreadRecord,
    }),
  );
}
