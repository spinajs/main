import 'mocha';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import sinon from 'sinon';
import { expect } from 'chai';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { InvalidArgument } from '@spinajs/exceptions';

import './common.js';
import { fsS3 } from './../src/index.js';
import { LOCALSTACK, bucketProvider, dropBucket, quiet, requireLocalstack, writeAll } from './backends.js';

const digest = (algorithm: string, data: Buffer | string) => createHash(algorithm).update(data).digest('hex');
// over lib-storage's 5 MiB part size: stored as a multipart object
const BIG = Buffer.alloc(6 * 1024 * 1024 + 7, 5);

function stubbed(metadata: Record<string, string>) {
  const s3 = new fsS3({ name: 's3-hash-unit', bucket: 'b' });
  const send = sinon.stub().callsFake(async (cmd: unknown) => {
    if (cmd instanceof HeadObjectCommand) return { Metadata: metadata };
    if (cmd instanceof GetObjectCommand) return { Body: Readable.from([Buffer.from('abc')]) };
    return {};
  });
  Object.defineProperty(s3, 'Logger', { value: quiet });
  Object.defineProperty(s3, 'S3', { value: { send } });
  const sent = (type: new (...args: never[]) => unknown) => send.getCalls().filter((c) => c.args[0] instanceof type).length;
  return { s3, send, sent };
}

describe('fs s3 hash (no server)', () => {
  afterEach(() => sinon.restore());

  it('returns the stored hash with one HeadObject and reads no content', async () => {
    const { s3, sent } = stubbed({ hash: 'stored' });
    expect(await s3.hash('a.txt')).to.equal('stored');
    expect([sent(HeadObjectCommand), sent(GetObjectCommand)]).to.deep.equal([1, 0]);
  });

  it("uses the stored hash for an explicit 'sha256' too", async () => {
    const { s3, sent } = stubbed({ hash: 'stored' });
    expect(await s3.hash('a.txt', 'SHA256')).to.equal('stored');
    expect(sent(GetObjectCommand)).to.equal(0);
  });

  it('streams the object when it has no stored hash', async () => {
    const { s3 } = stubbed({});
    expect(await s3.hash('a.txt')).to.equal(digest('sha256', 'abc'));
  });

  it('streams the object for another algorithm without asking for its metadata', async () => {
    const { s3, sent } = stubbed({ hash: 'stored', md5: 'stored-md5' });
    expect(await s3.hash('a.txt', 'md5')).to.equal(digest('md5', 'abc'));
    expect([sent(HeadObjectCommand), sent(GetObjectCommand)]).to.deep.equal([0, 1]);
  });

  it('rejects with the read error and destroys the body when the fallback read fails', async () => {
    const { s3, send } = stubbed({});
    const body = new Readable({ read() { this.destroy(new Error('read failed')); } });
    const bodyClosed = new Promise((resolve) => body.once('close', resolve));
    send.callsFake(async (cmd: unknown) => (cmd instanceof GetObjectCommand ? { Body: body } : { Metadata: {} }));

    await expect(s3.hash('a.txt')).to.be.rejectedWith('read failed');
    await bodyClosed;
    expect(body.destroyed).to.be.true;
  });

  it('refuses an unsupported algorithm before any request', async () => {
    const { s3, send } = stubbed({});
    await expect(s3.hash('a.txt', 'no-such-digest')).to.be.rejectedWith(InvalidArgument);
    expect(send.called).to.be.false;
  });
});

describe('fs s3 hash (localstack)', function () {
  this.timeout(60000);

  let s3: fsS3;
  let client: S3Client;
  let bucket: string;

  before(async function () {
    await requireLocalstack(this, 'fs s3 hash');
    ({ s3, client, bucket } = await bucketProvider(LOCALSTACK, 'fs-s3-hash'));
  });

  after(async () => {
    if (!s3) return;
    await dropBucket(client, bucket).catch((err) => console.warn(`      bucket ${bucket} not dropped: ${String(err)}`));
    await s3.dispose();
  });

  it('hashes an object written outside fsS3, without metadata, by streaming it', async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: 'plain.txt', Body: 'plain content' }));
    expect(await s3.hash('plain.txt')).to.equal(digest('sha256', 'plain content'));
  });

  it('hashes a multipart object by streaming it, with any supported algorithm', async () => {
    await new Upload({ client, params: { Bucket: bucket, Key: 'big.bin', Body: BIG } }).done();
    expect(await s3.hash('big.bin')).to.equal(digest('sha256', BIG));
    expect(await s3.hash('big.bin', 'sha512')).to.equal(digest('sha512', BIG));
  });

  it('keeps returning the stored hash metadata as it is, and computes md5 from the content', async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: 'stored.txt', Body: 'abc', Metadata: { hash: 'stored-value' } }));
    expect(await s3.hash('stored.txt')).to.equal('stored-value');
    expect(await s3.hash('stored.txt', 'md5')).to.equal(digest('md5', 'abc'));
  });

  it('hashes an object written by writeStream without metadata', async () => {
    await writeAll(s3, 'ws.bin', BIG);
    expect(await s3.hash('ws.bin')).to.equal(digest('sha256', BIG));
  });
});
