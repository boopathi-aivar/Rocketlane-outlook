import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

async function main() {
  const bucket = process.env.TEMPLATE_BUCKET;
  const key = process.env.TEMPLATE_KEY ?? 'templates/status-email.html';

  if (!bucket) {
    console.error('TEMPLATE_BUCKET env var is required');
    process.exit(1);
  }

  const path = resolve(__dirname, '..', 'templates', 'status-email.html');
  const body = readFileSync(path);

  const s3 = new S3Client({});
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'text/html; charset=utf-8',
      CacheControl: 'no-cache',
    }),
  );

  console.log(`Uploaded ${path} -> s3://${bucket}/${key}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
