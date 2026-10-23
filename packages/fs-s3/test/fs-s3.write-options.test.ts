import 'mocha';
import { once } from 'events';
import { PassThrough, Readable } from 'stream';
import sinon from 'sinon';
import { expect } from 'chai';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { IOFail, ResourceDuplicated } from '@spinajs/exceptions';

import './common.js';
import { fsS3 } from './../src/index.js';
import { LOCALSTACK, atomicBackend, bucketProvider, dropBucket, quiet, requireLocalstack, writeAll } from './backends.js';

const SMALL = Buffer.from('small body');
// over lib-storage's 5 MiB part size: written as a multipart upload
const BIG = Buffer.alloc(6 * 1024 * 1024 + 7, 1);

interface Command {
  input: Record<string, unknown>;
}

function stubbed(reply: (command: unknown) => unknown) {
  // a real client, so lib-storage finds the config it reads (endpoint, requestHandler); only send is replaced
  const client = new S3Client({ region: 'us-west-1', endpoint: 'http://localhost:1', forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const sent: Command[] = [];
  sinon.stub(client, 'send').callsFake((async (command: unknown) => {
    sent.push(command as Command);
    return reply(command);
  }) as never);
  const s3 = new fsS3({ name: 's3-ws-unit', bucket: 'b' });
  Object.defineProperty(s3, 'S3', { value: client });
  Object.defineProperty(s3, 'Logger', { value: quiet });
  return { s3, sent };
}

const refused = (status: number) => () => {
  throw new S3ServiceException({ name: status === 412 ? 'PreconditionFailed' : 'ConditionalRequestConflict', $fault: 'client', $metadata: { httpStatusCode: status } });
};

describe('fs s3 writeStream options (no server)', function () {
  this.timeout(5000);

  afterEach(() => sinon.restore());

  it('maps contentType, metadata and exclusive onto the PutObject of a small body', async () => {
    const { s3, sent } = stubbed(() => ({}));

    await writeAll(s3, '/a.txt', SMALL, { contentType: 'text/plain', metadata: { hash: 'h' }, exclusive: true });

    const [put] = sent.filter((c) => c instanceof PutObjectCommand);
    expect(put.input).to.include({ Key: 'a.txt', ContentType: 'text/plain', IfNoneMatch: '*' });
    expect(put.input.Metadata).to.deep.equal({ hash: 'h' });
  });

  it('sends no IfNoneMatch, ContentType or Metadata when no option asks for them', async () => {
    const { s3, sent } = stubbed(() => ({}));

    await writeAll(s3, 'a.txt', SMALL);

    const [put] = sent.filter((c) => c instanceof PutObjectCommand);
    expect(put.input.IfNoneMatch).to.equal(undefined);
    expect(put.input.ContentType).to.equal(undefined);
    expect(put.input.Metadata).to.equal(undefined);
  });

  for (const status of [409, 412]) {
    it(`an exclusive write refused with ${status} fails with ResourceDuplicated`, async () => {
      const { s3 } = stubbed(refused(status));
      await expect(writeAll(s3, 'taken.txt', SMALL, { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
    });
  }

  it('a 412 on a write that is not exclusive stays an IOFail', async () => {
    const { s3 } = stubbed(refused(412));
    const err = await writeAll(s3, 'a.txt', SMALL).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(IOFail);
    expect(err).to.not.be.instanceOf(ResourceDuplicated);
  });

  it('forwards an error of the source stream to the returned stream and stores nothing', async () => {
    const { s3, sent } = stubbed(() => ({}));
    const source = new PassThrough();
    const ws = await s3.writeStream('a.txt', source, {});
    const failed = once(ws, 'error');

    source.write('partial');
    source.destroy(new Error('source failed'));

    const [err] = await failed;
    expect((err as Error).message).to.equal('source failed');
    expect(sent.filter((c) => c instanceof PutObjectCommand)).to.have.length(0);
  });
});

describe('fs s3 writeStream options (localstack)', function () {
  this.timeout(60000);

  let s3: fsS3;
  let client: S3Client;
  let bucket: string;

  before(async function () {
    await requireLocalstack(this, 'fs s3 writeStream options');
    ({ s3, client, bucket } = await bucketProvider(LOCALSTACK, 'fs-s3-ws'));
  });

  after(async () => {
    if (!s3) return;
    await dropBucket(client, bucket).catch((err) => console.warn(`      bucket ${bucket} not dropped: ${String(err)}`));
    await s3.dispose();
  });

  const head = (Key: string) => client.send(new HeadObjectCommand({ Bucket: bucket, Key }));
  const firstByte = async (Key: string) => (await (await client.send(new GetObjectCommand({ Bucket: bucket, Key }))).Body!.transformToByteArray())[0];
  const openUploads = async (Key: string) => ((await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: Key }))).Uploads ?? []).filter((u) => u.Key === Key);
  async function eventually(check: () => Promise<boolean>, ms = 15000): Promise<void> {
    const until = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > until) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  for (const [path, body] of [['single PUT', SMALL], ['multipart', BIG]] as const) {
    it(`stores contentType and metadata on a ${path} object`, async () => {
      const key = `meta/${path.replace(' ', '-')}.bin`;

      await writeAll(s3, key, body, { contentType: 'application/x-test', metadata: { hash: 'h1', owner: 'o' } });

      const h = await head(key);
      expect(h).to.include({ ContentType: 'application/x-test', ContentLength: body.length });
      expect(h.Metadata).to.deep.equal({ hash: 'h1', owner: 'o' });
      if (path === 'multipart') expect(h.ETag).to.match(/-2"$/);
    });

    it(`an exclusive ${path} write to an existing key fails with ResourceDuplicated, keeps the first object and leaves no open upload`, async () => {
      const key = `excl/${path.replace(' ', '-')}.bin`;
      await writeAll(s3, key, body, { exclusive: true });

      await expect(writeAll(s3, key, Buffer.alloc(body.length, 9), { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);

      expect(await firstByte(key)).to.equal(body[0]);
      expect(await openUploads(key)).to.have.length(0);
    });
  }

  it('stores the options when the body comes as a source stream', async () => {
    const ws = await s3.writeStream('meta/source.bin', Readable.from([BIG], { objectMode: false }), { contentType: 'application/x-src', metadata: { hash: 'h2' } });
    await once(ws, 'close');

    const h = await head('meta/source.bin');
    expect(h).to.include({ ContentType: 'application/x-src', ContentLength: BIG.length });
    expect(h.Metadata).to.deep.equal({ hash: 'h2' });
  });

  it('a write that is not exclusive still overwrites', async () => {
    await writeAll(s3, 'overwrite.bin', Buffer.from('a'));
    await writeAll(s3, 'overwrite.bin', Buffer.from('b'));
    expect(await firstByte('overwrite.bin')).to.equal('b'.charCodeAt(0));
  });

  it('a single PUT write its writer destroys stores nothing', async () => {
    const ws = await s3.writeStream('destroyed/small.bin', {});
    ws.on('error', () => undefined);
    ws.write(Buffer.alloc(100, 3));
    ws.destroy(new Error('limit'));

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await s3.exists('destroyed/small.bin')).to.be.false;
  });

  it('a multipart write its writer destroys stores nothing and leaves no open upload', async () => {
    const key = 'destroyed/big.bin';
    const ws = await s3.writeStream(key, {});
    ws.on('error', () => undefined);
    ws.write(Buffer.alloc(7 * 1024 * 1024, 3));
    await eventually(async () => (await openUploads(key)).length === 1);

    ws.destroy(new Error('limit'));

    await eventually(async () => (await openUploads(key)).length === 0);
    expect(await s3.exists(key)).to.be.false;
  });
});

describe('fs s3 writeStream exclusive, concurrent writes (atomic backend)', function () {
  this.timeout(120000);

  const backend = atomicBackend();
  let s3: fsS3;
  let client: S3Client;
  let bucket: string;

  before(async function () {
    if (!backend) {
      console.warn('      skipped: set FS_S3_ATOMIC_ENDPOINT (+ _ACCESS_KEY, _SECRET_KEY, _REGION) to an S3 that enforces If-None-Match atomically; localstack 3.8.1 lets two concurrent exclusive multipart writes both succeed');
      this.skip();
    }
    ({ s3, client, bucket } = await bucketProvider(backend, 'fs-s3-race'));
  });

  after(async () => {
    if (!s3) return;
    await dropBucket(client, bucket).catch((err) => console.warn(`      bucket ${bucket} not dropped: ${String(err)}`));
    await s3.dispose();
  });

  it('of two concurrent exclusive multipart writes to one key exactly one succeeds; the other fails with ResourceDuplicated', async () => {
    const results = await Promise.allSettled([writeAll(s3, 'race.bin', Buffer.alloc(BIG.length, 0x61), { exclusive: true }), writeAll(s3, 'race.bin', Buffer.alloc(BIG.length, 0x62), { exclusive: true })]);

    expect(results.filter((r) => r.status === 'fulfilled')).to.have.length(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).to.be.instanceOf(ResourceDuplicated);
  });
});
