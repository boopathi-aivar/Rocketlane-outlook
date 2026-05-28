import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

interface Asset {
  localPath: string;
  s3Key: string;
  contentType: string;
}

async function main() {
  const bucket = process.env.TEMPLATE_BUCKET;
  const templateKey = process.env.TEMPLATE_KEY ?? 'templates/status-email.html';
  const logoKey = process.env.LOGO_KEY ?? 'templates/assets/aivar-logo.png';

  if (!bucket) {
    console.error('TEMPLATE_BUCKET env var is required');
    process.exit(1);
  }

  const assets: Asset[] = [
    {
      localPath: resolve(__dirname, '..', 'templates', 'status-email.html'),
      s3Key: templateKey,
      contentType: 'text/html; charset=utf-8',
    },
    {
      localPath: resolve(__dirname, '..', 'templates', 'assets', 'aivar-logo.png'),
      s3Key: logoKey,
      contentType: 'image/png',
    },
  ];

  const s3 = new S3Client({});
  for (const asset of assets) {
    const body = readFileSync(asset.localPath);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: asset.s3Key,
        Body: body,
        ContentType: asset.contentType,
        CacheControl: 'no-cache',
      }),
    );
    console.log(`Uploaded ${asset.localPath} -> s3://${bucket}/${asset.s3Key}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
