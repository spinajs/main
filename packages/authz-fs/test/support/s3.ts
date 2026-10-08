import { DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';

export const S3_ENDPOINT = process.env.AUTHZ_FS_S3_ENDPOINT ?? 'http://localhost:4566';

/** `fs.s3.config` for localstack. */
export const S3_CLIENT_CONFIG = { forcePathStyle: true, endpoint: S3_ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, region: 'us-west-1' };

export const S3_SKIP_HINT = `no localstack at ${S3_ENDPOINT} (docker run --rm -d -p 4566:4566 -e SERVICES=s3 localstack/localstack)`;

export async function s3Reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${S3_ENDPOINT}/_localstack/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Deletes every object of the bucket, then the bucket. */
export async function dropBucket(client: S3Client, bucket: string): Promise<void> {
  for (;;) {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => k !== undefined);
    if (keys.length === 0) break;
    for (const Key of keys) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

/** `AUTHZ_FS_S3=required` (release gate job): an unreachable localstack fails the S3 suites instead of skipping them. */
export const S3_REQUIRED = process.env.AUTHZ_FS_S3 === 'required';

/** For a mocha `before`: returns when localstack answers, else skips the suite, or throws under AUTHZ_FS_S3=required. */
export async function requireOrSkipS3(ctx: Mocha.Context, label: string): Promise<void> {
  if (await s3Reachable()) return;
  if (S3_REQUIRED) throw new Error(`${label}: AUTHZ_FS_S3=required, but ${S3_SKIP_HINT}`);
  console.warn(`      ${label} skipped: ${S3_SKIP_HINT}`);
  ctx.skip();
}
