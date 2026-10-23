import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { InvalidArgument, IOFail } from '@spinajs/exceptions';

import './common.js';
import { fsS3 } from './../src/index.js';
import { LOCALSTACK, bucketProvider, dropBucket, quiet, requireLocalstack } from './backends.js';

interface Command {
  input: Record<string, unknown>;
}

const many = (n: number, prefix = 'd/') => Array.from({ length: n }, (_, i) => ({ Key: `${prefix}${String(i).padStart(4, '0')}` }));

function stubbed(reply: (cmd: Command) => unknown) {
  const s3 = new fsS3({ name: 's3-rm-unit', bucket: 'b' });
  const send = sinon.stub().callsFake(async (cmd: Command) => reply(cmd) ?? {});
  Object.defineProperty(s3, 'Logger', { value: quiet });
  Object.defineProperty(s3, 'S3', { value: { send } });
  const sent = (type: new (...args: never[]) => unknown) => send.getCalls().map((c) => c.args[0] as Command).filter((c) => c instanceof type);
  return { s3, send, sent };
}

describe('fs s3 prefix rm (no server)', () => {
  afterEach(() => sinon.restore());

  it('deletes the key, then pages through its prefix and deletes each page with one quiet DeleteObjects', async () => {
    const { s3, sent } = stubbed((cmd) => {
      if (!(cmd instanceof ListObjectsV2Command)) return undefined;
      return cmd.input.ContinuationToken ? { Contents: [{ Key: 'd/last' }], IsTruncated: false } : { Contents: many(1000), IsTruncated: true, NextContinuationToken: 't1' };
    });

    await s3.rm('/d/');

    expect(sent(DeleteObjectCommand).map((c) => c.input.Key)).to.deep.equal(['d']);
    expect(sent(ListObjectsV2Command).map((c) => [c.input.Prefix, c.input.MaxKeys, c.input.ContinuationToken, c.input.Delimiter])).to.deep.equal([
      ['d/', 1000, undefined, undefined],
      ['d/', 1000, 't1', undefined],
    ]);
    const batches = sent(DeleteObjectsCommand).map((c) => c.input.Delete as { Objects: { Key: string }[]; Quiet: boolean });
    expect(batches.map((b) => [b.Objects.length, b.Quiet])).to.deep.equal([
      [1000, true],
      [1, true],
    ]);
    expect(batches[1].Objects[0].Key).to.equal('d/last');
  });

  it('splits a page longer than 1000 keys into DeleteObjects batches of at most 1000', async () => {
    const { s3, sent } = stubbed((cmd) => (cmd instanceof ListObjectsV2Command ? { Contents: many(1001) } : undefined));

    await s3.rm('d');

    expect(sent(DeleteObjectsCommand).map((c) => (c.input.Delete as { Objects: unknown[] }).Objects.length)).to.deep.equal([1000, 1]);
  });

  it('fails with IOFail naming the keys DeleteObjects could not remove', async () => {
    const { s3 } = stubbed((cmd) => {
      if (cmd instanceof ListObjectsV2Command) return { Contents: [{ Key: 'd/a' }, { Key: 'd/b' }] };
      if (cmd instanceof DeleteObjectsCommand) return { Errors: [{ Key: 'd/b', Code: 'AccessDenied' }] };
      return undefined;
    });

    await expect(s3.rm('d')).to.be.rejectedWith(IOFail, 'd/b (AccessDenied)');
  });

  it('removing a path that does not exist sends no DeleteObjects and succeeds', async () => {
    const { s3, sent } = stubbed(() => undefined);

    await s3.rm('ghost');

    expect(sent(DeleteObjectCommand)).to.have.length(1);
    expect(sent(ListObjectsV2Command)).to.have.length(1);
    expect(sent(DeleteObjectsCommand)).to.have.length(0);
  });

  it('refuses the bucket root before any request', async () => {
    const { s3, send } = stubbed(() => undefined);

    await expect(s3.rm('')).to.be.rejectedWith(InvalidArgument);
    await expect(s3.rm('/')).to.be.rejectedWith(InvalidArgument);
    expect(send.called).to.be.false;
  });

  it('move deletes only the source key: no listing, no DeleteObjects', async () => {
    const { s3, sent } = stubbed(() => undefined);

    await s3.move('k', 'k2');

    expect(sent(CopyObjectCommand)).to.have.length(1);
    expect(sent(DeleteObjectCommand).map((c) => c.input.Key)).to.deep.equal(['k']);
    expect(sent(ListObjectsV2Command)).to.have.length(0);
    expect(sent(DeleteObjectsCommand)).to.have.length(0);
  });
});

describe('fs s3 prefix rm (localstack)', function () {
  this.timeout(120000);

  let s3: fsS3;
  let client: S3Client;
  let bucket: string;

  before(async function () {
    await requireLocalstack(this, 'fs s3 prefix rm');
    ({ s3, client, bucket } = await bucketProvider(LOCALSTACK, 'fs-s3-rm'));
  });

  after(async () => {
    if (!s3) return;
    await dropBucket(client, bucket).catch((err) => console.warn(`      bucket ${bucket} not dropped: ${String(err)}`));
    await s3.dispose();
  });

  const put = (...keys: string[]) => Promise.all(keys.map((Key) => client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: 'x' }))));
  async function keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      out.push(...(page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : [])));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  }

  it('removes the key and every key under its prefix, and nothing that only starts with the same characters', async () => {
    await put('t1/tree', 't1/tree/', 't1/tree/a.txt', 't1/tree/sub/b.txt', 't1/tree-x.txt', 't1/treehouse/c.txt', 't1/other/tree/d.txt');

    await s3.rm('t1/tree');

    expect(await keys('t1/')).to.deep.equal(['t1/other/tree/d.txt', 't1/tree-x.txt', 't1/treehouse/c.txt']);
  });

  it('removes a prefix that holds only nested keys', async () => {
    await put('t2/nest/sub/a.txt', 't2/keep.txt');

    await s3.rm('/t2/nest/');

    expect(await keys('t2/')).to.deep.equal(['t2/keep.txt']);
  });

  it('removing a path that does not exist succeeds and removes nothing', async () => {
    await put('t3/keep.txt');

    await s3.rm('t3/ghost');

    expect(await keys('t3/')).to.deep.equal(['t3/keep.txt']);
  });

  it('removes more than one page of keys under a prefix', async () => {
    const all = many(1001, 't4/many/').map((o) => o.Key);
    for (let i = 0; i < all.length; i += 100) await put(...all.slice(i, i + 100));

    await s3.rm('t4/many');

    expect(await keys('t4/')).to.deep.equal([]);
  });

  it('move and rename delete only the source key: keys under its prefix stay', async () => {
    await put('t5/mv', 't5/mv/child.txt', 't5/rn', 't5/rn/child.txt');

    await s3.move('t5/mv', 't5/moved');
    await s3.rename('t5/rn', 't5/renamed');

    expect(await keys('t5/')).to.deep.equal(['t5/moved', 't5/mv/child.txt', 't5/renamed', 't5/rn/child.txt']);
  });

  it('refuses the bucket root and removes nothing', async () => {
    await put('t6/keep.txt');

    await expect(s3.rm('')).to.be.rejectedWith(InvalidArgument);
    await expect(s3.rm('/')).to.be.rejectedWith(InvalidArgument);

    expect(await keys('t6/')).to.deep.equal(['t6/keep.txt']);
  });
});
