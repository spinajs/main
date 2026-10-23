import 'mocha';
import { PassThrough } from 'stream';
import { expect } from 'chai';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import { fsS3 } from './../src/index.js';
import { LOCALSTACK, bucketProvider, dropBucket, requireLocalstack } from './backends.js';

const SMALL = Buffer.from('small body');
// lib-storage sends a body of up to 5 MiB as one PutObject and a larger one as a multipart upload
const BIG = Buffer.alloc(6 * 1024 * 1024 + 7, 1);

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('fs s3 backend behaviour (localstack)', function () {
  this.timeout(60000);

  let s3: fsS3;
  let client: S3Client;
  let bucket: string;

  before(async function () {
    await requireLocalstack(this, 'fs s3 backend behaviour');
    ({ s3, client, bucket } = await bucketProvider(LOCALSTACK, 'fs-s3-backend'));
  });

  after(async () => {
    if (!s3) return;
    await dropBucket(client, bucket).catch((err) => console.warn(`      bucket ${bucket} not dropped: ${String(err)}`));
    await s3.dispose();
  });

  const upload = (Key: string, Body: Buffer | PassThrough, extra: Partial<PutObjectCommandInput> = {}) => new Upload({ client, params: { Bucket: bucket, Key, Body, ...extra } });
  const content = async (Key: string) => (await client.send(new GetObjectCommand({ Bucket: bucket, Key }))).Body!.transformToByteArray();

  for (const [path, body] of [['single PUT', SMALL], ['multipart', BIG]] as const) {
    it(`lib-storage stores ContentType and Metadata on the ${path} path of a stream body`, async () => {
      const key = `meta-${path.replace(' ', '-')}`;
      const stream = new PassThrough();
      stream.end(body);
      const u = upload(key, stream, { ContentType: 'application/x-spike', Metadata: { hash: 'abc', other: 'v' } });
      await u.done();

      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      expect(head).to.include({ ContentType: 'application/x-spike', ContentLength: body.length });
      expect(head.Metadata).to.deep.equal({ hash: 'abc', other: 'v' });
      expect(u.uploadId === undefined, 'single PUT has no upload id').to.equal(path === 'single PUT');
    });

    it(`IfNoneMatch '*' refuses a second ${path} write with a 412 S3ServiceException named PreconditionFailed`, async () => {
      const key = `excl-${path.replace(' ', '-')}`;
      await upload(key, body, { IfNoneMatch: '*' }).done();

      const err = await failure(upload(key, Buffer.alloc(body.length, 9), { IfNoneMatch: '*' }).done());

      expect(err).to.be.instanceOf(S3ServiceException);
      expect(err).to.include({ name: 'PreconditionFailed' });
      expect((err as S3ServiceException).$metadata.httpStatusCode).to.equal(412);
      expect((await content(key))[0]).to.equal(body[0]);
    });
  }

  it('a refused CompleteMultipartUpload leaves its multipart upload open: lib-storage does not abort it', async () => {
    await upload('open-mpu', BIG, { IfNoneMatch: '*' }).done();
    const second = upload('open-mpu', BIG, { IfNoneMatch: '*' });
    await failure(second.done());

    const open = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: 'open-mpu' }));
    expect((open.Uploads ?? []).map((u) => u.UploadId)).to.include(second.uploadId);
  });

  it('DeleteObject with an empty key is sent as DeleteBucket', async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: 'keep.txt', Body: 'k' }));
    expect(await failure(client.send(new DeleteObjectCommand({ Bucket: bucket, Key: '' })))).to.include({ name: 'BucketNotEmpty' });
  });

  it('DeleteObject of a missing key succeeds', async () => {
    const res = await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'never-written.txt' }));
    expect(res.$metadata.httpStatusCode).to.equal(204);
  });
});

describe('fs s3 backend behaviour (node streams)', () => {
  it('a PassThrough drained by for-await is destroyed, so a later destroy(err) emits nothing; autoDestroy: false keeps it', async () => {
    for (const [autoDestroy, errors] of [[true, 0], [false, 1]] as const) {
      const stream = new PassThrough({ emitClose: false, autoDestroy });
      let seen = 0;
      stream.on('error', () => seen++);
      stream.end('x');

      // lib-storage reads the body this way (lib-storage/dist-cjs/index.js:128-137)
      const it = stream[Symbol.asyncIterator]();
      while (!(await it.next()).done) {
        /* drain */
      }

      expect(stream.destroyed, `autoDestroy ${autoDestroy}`).to.equal(autoDestroy);
      stream.destroy(new Error('late failure'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen, `autoDestroy ${autoDestroy}`).to.equal(errors);
    }
  });
});
