import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { posix } from 'path';
import { PassThrough } from 'stream';
import { ResourceDuplicated } from '@spinajs/exceptions';
import { fs, IZipResult } from '@spinajs/fs';
import './common.js';
import { fsFTP } from '../src/index.js';

// fsFTP logs through @Logger; these tests have no log module.
const quiet = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) });

const PUBLIC_FILE_METHODS = [
  'download', 'upload', 'hash', 'metadata', 'read', 'readStream', 'write', 'writeStream', 'append',
  'exists', 'stat', 'dirExists', 'isDir', 'list', 'mkdir', 'rm', 'copy', 'move', 'rename',
  'zip', 'unzip', 'signedUrl', 'getSignedUrl',
];

const HOOKS = [
  'doDownload', 'doUpload', 'doHash', 'doMetadata', 'doRead', 'doReadStream', 'doWrite', 'doWriteStream', 'doAppend',
  'doExists', 'doDirExists', 'doStat', 'doIsDir', 'doList', 'doMkdir', 'doRm', 'doCopy', 'doMove', 'doRename',
  'doZip', 'doUnzip',
];

interface Entry {
  isDirectory: boolean;
}

class FakeFtp {
  public cwd = '/';
  public readonly calls: string[] = [];
  public readonly sources: unknown[] = [];

  constructor(private readonly entries: Record<string, Entry> = {}) {}

  public async pwd() {
    return this.cwd;
  }

  public async cd(p: string) {
    this.cwd = this.abs(p);
  }

  public async ensureDir(p: string) {
    this.cwd = this.abs(p);
    this.calls.push(`ensureDir ${this.cwd}`);
  }

  public async list(p = '') {
    const target = this.abs(p);
    const entry = this.entries[target];
    if (entry && !entry.isDirectory) {
      return [this.info(target, entry)];
    }
    return Object.entries(this.entries)
      .filter(([key]) => posix.dirname(key) === target)
      .map(([key, e]) => this.info(key, e));
  }

  public async uploadFrom(source: unknown, to: string) {
    this.sources.push(source);
    this.calls.push(`uploadFrom ${this.abs(to)}`);
  }

  public async appendFrom(source: unknown, to: string) {
    this.sources.push(source);
    this.calls.push(`appendFrom ${this.abs(to)}`);
  }

  public async downloadTo(_destination: unknown, from: string) {
    this.calls.push(`downloadTo ${this.abs(from)}`);
  }

  public async remove(p: string) {
    this.calls.push(`remove ${this.abs(p)}`);
  }

  public async removeDir(p: string) {
    this.calls.push(`removeDir ${this.abs(p)}`);
  }

  public async rename(from: string, to: string) {
    this.calls.push(`rename ${this.abs(from)} ${this.abs(to)}`);
  }

  private abs(p: string) {
    return p.startsWith('/') ? posix.normalize(p) : posix.join(this.cwd, p);
  }

  private info(path: string, entry: Entry) {
    return { name: posix.basename(path), isDirectory: entry.isDirectory, isFile: !entry.isDirectory, size: 1, modifiedAt: new Date(0) };
  }
}

interface FtpInternals {
  doMove(oldPath: string, newPath: string, dstFs?: fs): Promise<void>;
  doZip(sources: string | (string | string[])[], dstFs: fs, dstFile: string): Promise<IZipResult>;
  doUnzip(srcPath: string, destPath: string, dstFs: fs): Promise<string>;
  zipDestination(): fs;
  unzipDestination(): fs;
}

function provider(entries: Record<string, Entry> = {}) {
  const p = new fsFTP({ name: 'ftp-unit', host: 'localhost', port: 21, user: 'u', password: 'p', logVerbose: false });
  const ftp = new FakeFtp(entries);
  const temp = {
    tmppath: () => '/tmp/ftp-unit',
    writeStream: async () => new PassThrough(),
    rm: sinon.stub().resolves(),
    zip: sinon.stub(),
    unzip: sinon.stub(),
  };
  Object.defineProperty(p, 'Logger', { value: quiet });
  Object.defineProperty(p, 'TempFs', { value: temp });
  (p as unknown as { FtpClient: FakeFtp }).FtpClient = ftp;
  return { p, ftp, temp, internals: p as unknown as FtpInternals };
}

describe('fsFTP – provider hooks', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('overrides no public file method', () => {
    for (const name of PUBLIC_FILE_METHODS) {
      expect(Object.prototype.hasOwnProperty.call(fsFTP.prototype, name), name).to.be.false;
    }
  });

  it('implements every provider hook', () => {
    for (const name of HOOKS) {
      expect(Object.prototype.hasOwnProperty.call(fsFTP.prototype, name), name).to.be.true;
    }
  });

  it('uploads under the destination the core resolved', async () => {
    const { p, ftp } = provider();

    await p.upload('/local/a.txt');
    await p.upload('/local/a.txt', '/sub/b.txt');

    expect(ftp.calls).to.deep.equal(['ensureDir /', 'uploadFrom /a.txt', 'ensureDir /sub', 'uploadFrom /sub/b.txt']);
  });

  it('refuses an exclusive upload onto an existing file before sending it', async () => {
    const { p, ftp } = provider({ '/sub': { isDirectory: true }, '/sub/b.txt': { isDirectory: false } });

    await expect(p.upload('/local/a.txt', '/sub/b.txt', { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
    expect(ftp.calls.filter((c) => c.startsWith('uploadFrom'))).to.deep.equal([]);

    await p.upload('/local/a.txt', 'sub/c.txt', { exclusive: true });
    expect(ftp.calls).to.include('uploadFrom /sub/c.txt');
  });

  it('writes a Uint8Array as bytes', async () => {
    const { p, ftp } = provider();

    await p.write('/sub/a.bin', new Uint8Array([1, 2]));

    const chunks: Buffer[] = [];
    for await (const chunk of ftp.sources[0] as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks)).to.deep.equal(Buffer.from([1, 2]));
    expect(ftp.calls).to.include('uploadFrom /sub/a.bin');
  });

  it('tells a directory from a file', async () => {
    const { p } = provider({ '/sub': { isDirectory: true }, '/sub/a.txt': { isDirectory: false } });

    expect(await p.isDir('/sub')).to.be.true;
    expect(await p.dirExists('sub')).to.be.true;
    expect(await p.isDir('sub/a.txt')).to.be.false;
    expect(await p.exists('sub/a.txt')).to.be.true;
    expect(await p.isDir('missing')).to.be.false;
  });

  it('zips downloaded files on the destination it is given', async () => {
    const { p, temp, internals } = provider();
    const result = {} as IZipResult;
    temp.zip.resolves(result);
    sinon.stub(p, 'download').callsFake(async (remote: string) => `/tmp/${remote}`);
    const dst = {} as fs;

    expect(await internals.doZip(['sub/a.txt', ['b.txt', 'B.txt']], dst, 'out.zip')).to.equal(result);

    expect(temp.zip.calledOnceWithExactly([['/tmp/sub/a.txt', 'sub/a.txt'], ['/tmp/b.txt', 'B.txt']], dst, 'out.zip')).to.be.true;
    expect(temp.rm.getCalls().map((c) => c.args[0])).to.deep.equal(['/tmp/sub/a.txt', '/tmp/b.txt']);
  });

  it('unzips the downloaded archive on the destination it is given', async () => {
    const { p, temp, internals } = provider();
    temp.unzip.resolves('out');
    sinon.stub(p, 'download').resolves('/tmp/z.zip');
    const dst = {} as fs;

    expect(await internals.doUnzip('z.zip', 'out', dst)).to.equal('out');

    expect(temp.unzip.calledOnceWithExactly('/tmp/z.zip', 'out', dst)).to.be.true;
    expect(temp.rm.calledOnceWithExactly('/tmp/z.zip')).to.be.true;
  });

  it('zips and unzips onto the temp fs when no destination fs is given', () => {
    const { temp, internals } = provider();

    expect(internals.zipDestination()).to.equal(temp);
    expect(internals.unzipDestination()).to.equal(temp);
  });
});

describe('fsFTP – root-relative remote paths', () => {
  const entries: Record<string, Entry> = { '/sub': { isDirectory: true }, '/sub/test.txt': { isDirectory: false } };

  afterEach(() => {
    sinon.restore();
  });

  it('stats a file whatever directory the previous command left', async () => {
    const { p, ftp } = provider(entries);

    ftp.cwd = '/elsewhere';
    expect((await p.stat('sub/test.txt')).IsFile).to.be.true;

    ftp.cwd = '/elsewhere';
    expect(await p.exists('/sub/test.txt')).to.be.true;
  });

  it('lists a directory whatever directory the previous command left', async () => {
    const { p, ftp } = provider(entries);

    ftp.cwd = '/elsewhere';
    expect(await p.list('/sub')).to.deep.equal(['test.txt']);

    ftp.cwd = '/elsewhere';
    expect(await p.list('/')).to.deep.equal(['sub']);
  });

  it('renames, moves and creates directories by root-relative path', async () => {
    const { p, ftp } = provider(entries);

    ftp.cwd = '/elsewhere';
    await p.rename('sub/test.txt', '/sub/renamed.txt');
    ftp.cwd = '/elsewhere';
    await p.move('/sub/renamed.txt', 'moved.txt');
    ftp.cwd = '/elsewhere';
    await p.mkdir('a/b');

    expect(ftp.calls).to.deep.equal(['rename /sub/test.txt /sub/renamed.txt', 'rename /sub/renamed.txt /moved.txt', 'ensureDir /a/b']);
  });

  it('copies within the server to a root-relative destination', async () => {
    const { p, ftp, temp } = provider(entries);

    await p.copy('sub/test.txt', 'other/copy.txt');

    expect(ftp.calls.filter((c) => c.startsWith('uploadFrom'))).to.deep.equal(['uploadFrom /other/copy.txt']);
    expect(temp.rm.calledOnceWithExactly('/tmp/ftp-unit')).to.be.true;
  });

  it('removes the source by root-relative path after moving it to another fs', async () => {
    const { ftp, internals } = provider(entries);
    const upload = sinon.stub().resolves();

    await internals.doMove('sub/test.txt', 'b.txt', { upload } as unknown as fs);

    expect(upload.calledOnceWithExactly('/tmp/ftp-unit', 'b.txt')).to.be.true;
    expect(ftp.calls).to.include('remove /sub/test.txt');
  });
});
