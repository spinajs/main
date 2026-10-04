import 'mocha';
import { randomUUID } from 'crypto';
import { expect } from 'chai';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { fsS3 } from './../src/index.js';

const ENDPOINT = process.env.FS_S3_TEST_ENDPOINT ?? 'http://localhost:4566';

async function reachable(): Promise<boolean> {
  try {
    return (await fetch(`${ENDPOINT}/_localstack/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

// fsS3 logs through @Logger; these tests have no log module.
const quiet = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) });

describe('fs s3 setMetadata', function () {
  this.timeout(60000);

  const bucket = `fs-s3-meta-${randomUUID().slice(0, 8)}`;
  let s3: fsS3;
  let client: S3Client;

  before(async function () {
    if (!(await reachable())) {
      console.warn(`      fs s3 setMetadata skipped: no localstack at ${ENDPOINT}`);
      this.skip();
    }
    s3 = new fsS3({ name: 's3-meta', bucket } as never);
    Object.defineProperty(s3, 'Logger', { value: quiet });
    Object.defineProperty(s3, 'AwsConfig', { value: { forcePathStyle: true, endpoint: ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, region: 'us-west-1' } });
    await s3.resolve();
    client = (s3 as unknown as { S3: S3Client }).S3;
  });

  // fsS3.read downloads through its temp filesystem, which these tests do not set up.
  const content = async (key: string): Promise<string | undefined> => (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body?.transformToString();

  after(() => {
    client?.destroy();
  });

  it('replaces the user metadata and keeps the content and the content headers', async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: 'a.csv', Body: 'x,y', ContentType: 'text/csv', ContentDisposition: 'attachment', CacheControl: 'max-age=60', ContentLanguage: 'pl', Metadata: { old: '1', hash: 'h' } }));
    await s3.setMetadata('a.csv', { hash: 'h', 'authz-meta': 'v' });
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: 'a.csv' }));
    expect(head.Metadata).to.deep.equal({ hash: 'h', 'authz-meta': 'v' });
    expect(head).to.include({ ContentType: 'text/csv', ContentDisposition: 'attachment', CacheControl: 'max-age=60', ContentLanguage: 'pl' });
    expect(await content('a.csv')).to.equal('x,y');
    expect(await s3.getMetadata('a.csv')).to.deep.equal({ hash: 'h', 'authz-meta': 'v' });
  });

  it('works for keys with spaces and characters outside ASCII', async () => {
    const key = 'docs/zażółć gęślą/a b+c.txt';
    await s3.write(key, 'content');
    await s3.setMetadata(key, { 'authz-meta': 'w' });
    expect(await s3.getMetadata(key)).to.deep.equal({ 'authz-meta': 'w' });
    expect(await content(key)).to.equal('content');
  });

  it('rejects for a missing object', async () => {
    let error: unknown;
    await s3.setMetadata('missing.txt', { a: 'b' }).catch((e: unknown) => (error = e));
    expect(error).to.be.an('error');
  });
});
