import { randomUUID } from 'crypto';
import {
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

import { fsS3 } from './../src/index.js';

export interface S3Backend {
  readonly name: string;
  readonly config: { forcePathStyle: true; endpoint: string; credentials: { accessKeyId: string; secretAccessKey: string }; region: string };
}

const LOCALSTACK_ENDPOINT = process.env.FS_S3_TEST_ENDPOINT ?? 'http://localhost:4566';

export const LOCALSTACK: S3Backend = {
  name: 'localstack',
  config: { forcePathStyle: true, endpoint: LOCALSTACK_ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, region: 'us-west-1' },
};

/** A backend that enforces IfNoneMatch between concurrent writes (AWS, MinIO); localstack 3.8.1 does not. */
export function atomicBackend(): S3Backend | undefined {
  const endpoint = process.env.FS_S3_ATOMIC_ENDPOINT;
  if (!endpoint) return undefined;
  return {
    name: 'atomic',
    config: {
      forcePathStyle: true,
      endpoint,
      credentials: { accessKeyId: process.env.FS_S3_ATOMIC_ACCESS_KEY ?? 'test', secretAccessKey: process.env.FS_S3_ATOMIC_SECRET_KEY ?? 'test' },
      region: process.env.FS_S3_ATOMIC_REGION ?? 'us-east-1',
    },
  };
}

const HINT = `no localstack at ${LOCALSTACK_ENDPOINT} (docker compose -f packages/fs-s3/test/docker-compose.yml up -d localstack)`;

/** `FS_S3_LOCALSTACK=required`: an unreachable localstack fails the suites that need it instead of skipping them. */
const REQUIRED = process.env.FS_S3_LOCALSTACK === 'required';

async function localstackReachable(): Promise<boolean> {
  try {
    return (await fetch(`${LOCALSTACK_ENDPOINT}/_localstack/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** For a mocha `before`: returns when localstack answers, else skips the suite, or throws under FS_S3_LOCALSTACK=required. */
export async function requireLocalstack(ctx: Mocha.Context, label: string): Promise<void> {
  if (await localstackReachable()) return;
  if (REQUIRED) throw new Error(`${label}: FS_S3_LOCALSTACK=required, but ${HINT}`);
  console.warn(`      ${label} skipped: ${HINT}`);
  ctx.skip();
}

// fsS3 logs through @Logger; these tests have no log module.
export const quiet = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) });

/** An fsS3 on a fresh bucket, without DI: Logger and AwsConfig are set by hand. */
export async function bucketProvider(backend: S3Backend, prefix: string): Promise<{ s3: fsS3; client: S3Client; bucket: string }> {
  const bucket = `${prefix}-${randomUUID().slice(0, 8)}`;
  const s3 = new fsS3({ name: `${prefix}-${backend.name}`, bucket });
  Object.defineProperty(s3, 'Logger', { value: quiet });
  Object.defineProperty(s3, 'AwsConfig', { value: backend.config });
  await s3.resolve();
  return { s3, client: (s3 as unknown as { S3: S3Client }).S3, bucket };
}

/** Aborts open multipart uploads, deletes every object, then the bucket. */
export async function dropBucket(client: S3Client, bucket: string): Promise<void> {
  const open = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
  for (const u of open.Uploads ?? []) {
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key, UploadId: u.UploadId }));
  }
  for (;;) {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
    const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objects.length === 0) break;
    await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}
