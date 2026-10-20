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

  it('reads and replaces metadata under the normalised key', async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: 'norm/b.txt', Body: 'b' }));

    await s3.setMetadata('/norm//b.txt', { 'authz-meta': 'n' });

    expect((await client.send(new HeadObjectCommand({ Bucket: bucket, Key: 'norm/b.txt' }))).Metadata).to.deep.equal({ 'authz-meta': 'n' });
    expect(await s3.getMetadata('norm/b.txt')).to.deep.equal({ 'authz-meta': 'n' });
  });
});

describe('fs s3 without a server', function () {
  const sent: { input: Record<string, unknown> }[] = [];
  let replies: unknown[] = [];

  function provider() {
    const s3 = new fsS3({ name: 's3-stub', bucket: 'b' } as never);
    Object.defineProperty(s3, 'Logger', { value: quiet });
    Object.defineProperty(s3, 'S3', { value: { send: async (c: { input: Record<string, unknown> }) => (sent.push(c), replies.shift() ?? {}), destroy: () => undefined } });
    return s3;
  }

  beforeEach(() => {
    sent.length = 0;
    replies = [];
  });

  it('metadata() returns IFileInfo fields from the lowercased string metadata', async () => {
    replies = [{ Metadata: { height: '1080', mimetype: 'video/mp4', hash: 'h' } }];
    const info = await provider().metadata('a.mp4');
    expect(info.Height).to.equal(1080);
    expect(info.MimeType).to.equal('video/mp4');
    expect(info.hash).to.equal('h');
  });

  it('copy() URL-encodes the key in CopySource', async () => {
    await provider().copy('docs/zażółć a+b.txt', 'c.txt');
    expect(sent[0].input.CopySource).to.equal('b/docs/za%C5%BC%C3%B3%C5%82%C4%87%20a%2Bb.txt');
  });

  it('list() follows continuation tokens', async () => {
    replies = [{ Contents: [{ Key: 'a' }], IsTruncated: true, NextContinuationToken: 't' }, { Contents: [{ Key: 'b' }], IsTruncated: false }];
    expect(await provider().list('')).to.deep.equal(['a', 'b']);
    expect(sent[1].input.ContinuationToken).to.equal('t');
  });
});
