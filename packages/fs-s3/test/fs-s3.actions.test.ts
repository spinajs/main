import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PassThrough } from 'stream';
import { InvalidArgument, MethodNotImplemented } from '@spinajs/exceptions';
import { fs, IZipResult } from '@spinajs/fs';
import './common.js';
import { fsS3 } from './../src/index.js';

// fsS3 logs through @Logger; these tests have no log module.
const quiet = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) });

const PUBLIC_FILE_METHODS = [
  'download', 'upload', 'hash', 'metadata', 'read', 'readStream', 'write', 'writeStream', 'append',
  'exists', 'stat', 'dirExists', 'isDir', 'list', 'hasEntries', 'mkdir', 'rm', 'copy', 'move', 'rename',
  'zip', 'unzip', 'signedUrl', 'getSignedUrl',
];

const HOOKS = [
  'doDownload', 'doUpload', 'doHash', 'doMetadata', 'doRead', 'doReadStream', 'doWrite', 'doWriteStream', 'doAppend',
  'doExists', 'doDirExists', 'doStat', 'doIsDir', 'doList', 'doHasEntries', 'doMkdir', 'doRm', 'doCopy', 'doMove', 'doRename',
  'doZip', 'doUnzip', 'doSignedUrl',
];

interface S3Internals {
  S3: { send: sinon.SinonStub };
  doCopy(path: string, dest: string, dstFs?: fs): Promise<void>;
  doZip(sources: string | (string | string[])[], dstFs: fs, dstFile: string): Promise<IZipResult>;
  doUnzip(srcPath: string, destPath: string, dstFs: fs): Promise<string>;
  zipDestination(): fs;
  unzipDestination(): fs;
  runAction(...args: unknown[]): Promise<unknown>;
}

interface Command {
  input: Record<string, unknown>;
}

function provider() {
  const p = new fsS3({ name: 's3-unit', bucket: 'unit-bucket' });
  const internals = p as unknown as S3Internals;
  const send = sinon.stub().callsFake(async (cmd: unknown) => {
    if (cmd instanceof ListObjectsV2Command) return { Contents: [{ Key: 'dir/a.txt' }] };
    if (cmd instanceof HeadObjectCommand) return { Metadata: { hash: 'h' }, ContentType: 'text/plain', ContentLength: 3 };
    return {};
  });
  Object.defineProperty(p, 'Logger', { value: quiet });
  internals.S3 = { send };
  return { p, internals, send };
}

// lib-storage's Upload reads the client's config, so a real client with a stubbed send stands in for S3.
function streamingProvider() {
  const p = new fsS3({ name: 's3-unit', bucket: 'unit-bucket' });
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'unit', secretAccessKey: 'unit' } });
  const send = sinon.stub().resolves({});
  (client as unknown as { send: sinon.SinonStub }).send = send;
  Object.defineProperty(p, 'Logger', { value: quiet });
  (p as unknown as { S3: S3Client }).S3 = client;
  return { p, send };
}

const closed = (stream: NodeJS.WritableStream): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.on('close', () => resolve());
    stream.on('error', reject);
  });

function sent(send: sinon.SinonStub, type: new (...args: never[]) => unknown): Command[] {
  return send
    .getCalls()
    .map((c) => c.args[0])
    .filter((c) => c instanceof type) as Command[];
}

describe('fsS3 – provider hooks', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('overrides no public file method', () => {
    for (const name of PUBLIC_FILE_METHODS) {
      expect(Object.prototype.hasOwnProperty.call(fsS3.prototype, name), name).to.be.false;
    }
  });

  it('implements every provider hook', () => {
    for (const name of HOOKS) {
      expect(Object.prototype.hasOwnProperty.call(fsS3.prototype, name), name).to.be.true;
    }
  });

  it("uses one key for '/x', 'x' and 'x/./'", async () => {
    const { p, send } = provider();

    await p.exists('/dir/a.txt');
    await p.exists('dir/a.txt');
    await p.exists('dir/./a.txt');

    expect(sent(send, HeadObjectCommand).map((c) => c.input.Key)).to.deep.equal(['dir/a.txt', 'dir/a.txt', 'dir/a.txt']);
  });

  it('reads hash and stat from the normalised key', async () => {
    const { p, send } = provider();

    expect(await p.hash('/dir/a.txt')).to.equal('h');
    expect((await p.stat('\\dir\\a.txt')).Size).to.equal(3);

    expect(sent(send, HeadObjectCommand).map((c) => c.input.Key)).to.deep.equal(['dir/a.txt', 'dir/a.txt']);
  });

  it('removes, copies, moves and renames normalised keys', async () => {
    const { p, send } = provider();

    await p.rm('/a.txt');
    await p.copy('/a.txt', '/b/c.txt');
    await p.move('a.txt', '/m.txt');
    await p.rename('/m.txt', 'r.txt');

    expect(sent(send, CopyObjectCommand).map((c) => [c.input.CopySource, c.input.Key])).to.deep.equal([
      ['unit-bucket/a.txt', 'b/c.txt'],
      ['unit-bucket/a.txt', 'm.txt'],
      ['unit-bucket/m.txt', 'r.txt'],
    ]);
    expect(sent(send, DeleteObjectCommand).map((c) => c.input.Key)).to.deep.equal(['a.txt', 'a.txt', 'm.txt']);
  });

  it('reports no key and no prefix as a directory', async () => {
    const { p, send } = provider();

    expect(await p.isDir('dir/a.txt')).to.be.false;
    expect(await p.isDir('/dir/')).to.be.false;
    expect(await p.dirExists('dir')).to.be.true;
    expect(send.called).to.be.false;
  });

  it('hasEntries counts keys nested under the prefix: one ListObjectsV2 without Delimiter, MaxKeys 1', async () => {
    const { p, send } = provider();
    send.callsFake(async (cmd: unknown) => {
      if (!(cmd instanceof ListObjectsV2Command)) return {};
      const prefix = (cmd as unknown as Command).input.Prefix as string;
      // only d/sub/a.txt exists: a Delimiter '/' listing of 'd/' would return it as a common prefix, not as an object
      return 'd/sub/a.txt'.startsWith(prefix) ? { KeyCount: 1, Contents: [{ Key: 'd/sub/a.txt' }] } : { KeyCount: 0 };
    });

    expect(await p.hasEntries('/d')).to.be.true;
    expect(await p.hasEntries('e')).to.be.false;
    expect(await p.hasEntries('')).to.be.true;
    expect(sent(send, ListObjectsV2Command).map((c) => c.input)).to.deep.equal([
      { Bucket: 'unit-bucket', Prefix: 'd/', MaxKeys: 1 },
      { Bucket: 'unit-bucket', Prefix: 'e/', MaxKeys: 1 },
      { Bucket: 'unit-bucket', Prefix: '', MaxKeys: 1 },
    ]);
  });

  it('hasEntries propagates a failed listing', async () => {
    const { p, send } = provider();
    send.rejects(new Error('throttled'));

    let error: unknown;
    try {
      await p.hasEntries('d');
    } catch (e) {
      error = e;
    }
    expect(String(error)).to.contain('throttled');
  });

  it('refuses a path above the root before any request', async () => {
    const { p, send } = provider();

    await expect(Promise.resolve().then(() => p.exists('../a.txt'))).to.be.rejectedWith(InvalidArgument);
    expect(send.called).to.be.false;
  });

  it('copies to another fs by uploading the downloaded file there', async () => {
    const { p, internals } = provider();
    const rm = sinon.stub().resolves();
    Object.defineProperty(p, 'TempFs', { value: { rm } });
    sinon.stub(p, 'download').resolves('/tmp/a.txt');
    const upload = sinon.stub().resolves();

    await internals.doCopy('a.txt', 'b.txt', { upload } as unknown as fs);

    expect(upload.calledOnceWithExactly('/tmp/a.txt', 'b.txt')).to.be.true;
    expect(rm.calledOnceWithExactly('/tmp/a.txt')).to.be.true;
  });

  it('zips downloaded objects on the destination it is given', async () => {
    const { p, internals } = provider();
    const result = {} as IZipResult;
    const zip = sinon.stub().resolves(result);
    const rm = sinon.stub().resolves();
    Object.defineProperty(p, 'TempFs', { value: { zip, rm } });
    sinon.stub(p, 'download').callsFake(async (key: string) => `/tmp/${key}`);
    const dst = {} as fs;

    expect(await internals.doZip(['dir/a.txt', ['b.txt', 'B.txt']], dst, 'out.zip')).to.equal(result);

    expect(zip.calledOnceWithExactly([['/tmp/dir/a.txt', 'dir/a.txt'], ['/tmp/b.txt', 'B.txt']], dst, 'out.zip')).to.be.true;
    expect(rm.getCalls().map((c) => c.args[0])).to.deep.equal(['/tmp/dir/a.txt', '/tmp/b.txt']);
  });

  it('unzips the downloaded archive on the destination it is given', async () => {
    const { p, internals } = provider();
    const unzip = sinon.stub().resolves('out');
    const rm = sinon.stub().resolves();
    Object.defineProperty(p, 'TempFs', { value: { unzip, rm } });
    sinon.stub(p, 'download').resolves('/tmp/z.zip');
    const dst = {} as fs;

    expect(await internals.doUnzip('z.zip', 'out', dst)).to.equal('out');

    expect(unzip.calledOnceWithExactly('/tmp/z.zip', 'out', dst)).to.be.true;
    expect(rm.calledOnceWithExactly('/tmp/z.zip')).to.be.true;
  });

  it('zips and unzips onto the temp fs when no destination fs is given', () => {
    const { p, internals } = provider();
    const temp = {} as fs;
    Object.defineProperty(p, 'TempFs', { value: temp });

    expect(internals.zipDestination()).to.equal(temp);
    expect(internals.unzipDestination()).to.equal(temp);
  });

  it("lists a directory as the key prefix 'dir/'", async () => {
    const { p, send } = provider();

    expect(await p.list('dir')).to.deep.equal(['dir/a.txt']);
    await p.list('/dir/');
    await p.list('');
    await p.list('/');

    expect(sent(send, ListObjectsV2Command).map((c) => [c.input.Prefix, c.input.Delimiter])).to.deep.equal([
      ['dir/', '/'],
      ['dir/', '/'],
      ['', '/'],
      ['', '/'],
    ]);
  });

  it('uploads a stream write under the normalised key, from a source stream or from the returned stream', async () => {
    const { p, send } = streamingProvider();

    const source = new PassThrough();
    const piped = await p.writeStream('/dir/a.txt', source);
    const pipedClosed = closed(piped);
    source.end('abc');
    await pipedClosed;

    const direct = await p.writeStream('dir/b.txt', { encoding: 'utf-8', contentType: 'text/plain', metadata: { hash: 'h' } });
    const directClosed = closed(direct);
    direct.end('de');
    await directClosed;

    expect(sent(send, PutObjectCommand).map((c) => [c.input.Key, String(c.input.Body)])).to.deep.equal([
      ['dir/a.txt', 'abc'],
      ['dir/b.txt', 'de'],
    ]);
  });

  it('refuses an exclusive stream write before any request', async () => {
    const { p, send } = streamingProvider();

    await expect(p.writeStream('a.txt', { exclusive: true })).to.be.rejectedWith(MethodNotImplemented);
    expect(send.called).to.be.false;
  });

  it('reads object metadata as a stat action on the normalised key', async () => {
    const { p, internals, send } = provider();
    const runAction = sinon.spy(internals, 'runAction');

    expect(await p.getMetadata('/dir/a.txt')).to.deep.equal({ hash: 'h' });

    expect(runAction.firstCall.args.slice(0, 3)).to.deep.equal(['getMetadata', [{ path: '/dir/a.txt', kind: 'file', access: ['stat'] }], []]);
    expect(sent(send, HeadObjectCommand).map((c) => c.input.Key)).to.deep.equal(['dir/a.txt']);
  });

  it('replaces object metadata as a write action on the normalised key', async () => {
    const { p, internals, send } = provider();
    const runAction = sinon.spy(internals, 'runAction');

    await p.setMetadata('/dir/a b.txt', { a: 'b' });

    expect(runAction.firstCall.args.slice(0, 3)).to.deep.equal([
      'setMetadata',
      [{ path: '/dir/a b.txt', kind: 'file', access: ['write'] }],
      [{ a: 'b' }],
    ]);
    expect(sent(send, HeadObjectCommand).map((c) => c.input.Key)).to.deep.equal(['dir/a b.txt']);
    const [copy] = sent(send, CopyObjectCommand);
    expect(copy.input).to.include({ Key: 'dir/a b.txt', CopySource: 'unit-bucket/dir/a%20b.txt', MetadataDirective: 'REPLACE', ContentType: 'text/plain' });
    expect(copy.input.Metadata).to.deep.equal({ a: 'b' });
  });
});
