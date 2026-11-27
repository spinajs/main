import 'mocha';
import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { IOFail } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';
import { fsNative } from '../src/index.js';
import type { fs, IFsLocalOptions } from '../src/index.js';
import { fsApp } from './common.js';
import { archiveEntryTarget } from '../src/archive.js';
import type { ArchiveEntry } from '../src/archive.js';
import { junction, largeZip, S_IFLNK, zipArchive } from './support/zip.js';
import type { ZipEntry, ZipSandbox } from './support/zip.js';

// Every entry below `path`: directories end in '/'. list() names links too, so a link the unzip made shows up here.
async function tree(f: fs, path: string, skip: string[] = []): Promise<string[]> {
  const out: string[] = [];
  for (const name of await f.list(path || '/')) {
    const p = path ? `${path}/${name}` : name;
    if (skip.includes(p)) continue;
    if (await f.isDir(p)) out.push(`${p}/`, ...(await tree(f, p, skip)));
    else out.push(p);
  }
  return out.sort();
}

async function sha256(f: fs, path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = await f.readStream(path);
  stream.on('data', (part: string | Buffer) => hash.update(part));
  await finished(stream);
  return hash.digest('hex');
}

async function local(name: string, basePath: string): Promise<fsNative<IFsLocalOptions>> {
  const f = new fsNative({ name, service: 'fsNative', basePath });
  await f.resolve();
  return f;
}

describe('fs unzip entry names', function () {
  this.timeout(30000);

  let app: TestApp;
  let root: fsNative<IFsLocalOptions>;
  let sandbox: string;
  let provider: fsNative<IFsLocalOptions>;

  before(async () => {
    app = await fsApp();
    root = await local('unzip-root', join(tmpdir(), `spinajs-fs-unzip-${randomUUID()}`));
  });

  after(async () => {
    await root.rm('/');
    await app.dispose();
  });

  const escapeTarget = () => join(sandbox, 'outside', 'escaped-abs.txt');

  let n = 0;
  beforeEach(async () => {
    sandbox = join(root.BasePath ?? '', `case-${n++}`);
    provider = await local('unzip-entries', sandbox);
    await provider.mkdir('archives');
    await provider.mkdir('outside');
  });

  // The destination sits inside `outside/`, so a climbing entry that slipped through would land there, in the sandbox.
  const DEST = 'outside/dest';
  const guard = (): ZipSandbox => ({ root: sandbox, destination: join(sandbox, 'outside', 'dest') });

  async function unzip(entries: ZipEntry[]): Promise<string> {
    await provider.write('archives/a.zip', zipArchive(entries, guard()));
    return provider.unzip('archives/a.zip', DEST, provider);
  }

  async function expectRefused(entries: ZipEntry[], bad: string, reason: RegExp) {
    const err: unknown = await unzip(entries).then(
      () => undefined,
      (e: unknown) => e,
    );

    if (!(err instanceof IOFail)) expect.fail(`unzip must fail with IOFail, it ended with ${String(err)}`);
    expect(err.message).to.contain(JSON.stringify(bad));
    expect(err.message).to.match(reason);
    expect(await tree(provider, '', ['archives']), 'nothing may be written, inside the destination or outside').to.deep.equal(['outside/']);
  }

  const outsideNames = [
    '../escaped.txt',
    'sub/../../escaped.txt',
    '..\\escaped.txt',
    // a string-prefix check (unzipper 0.12.1 to 0.12.4) lets this one through: `dest-sibling` starts with `dest`
    '../dest-sibling/escaped.txt',
  ];

  for (const name of outsideNames) {
    it(`refuses ${name}, which resolves outside the destination`, async () => {
      await expectRefused([{ name: 'good.txt', data: 'good' }, { name, data: 'x' }], name, /resolves outside the destination/);
    });
  }

  it('refuses a climbing entry of 1 MiB without hanging', async () => {
    await expectRefused([{ name: '../escaped.txt', data: Buffer.alloc(1024 * 1024, 0x61) }], '../escaped.txt', /resolves outside the destination/);
  });

  // Spellings of <sandbox>/outside/escaped-abs.txt, so a name that slipped through lands in the sandbox. On posix a drive
  // or backslash spelling is an ordinary relative name, and a broken check would write it inside the destination.
  const windows = sep === '\\';
  const absoluteNames: [string, () => string][] = [
    ['rooted, without a drive', () => (windows ? escapeTarget().slice(2) : escapeTarget()).replace(/\\/g, '/')],
    ['with a drive and backslashes', () => (windows ? escapeTarget() : `C:${escapeTarget().replace(/\//g, '\\')}`)],
    ['with a drive and forward slashes', () => (windows ? escapeTarget().replace(/\\/g, '/') : `C:${escapeTarget()}`)],
    ['drive-relative', () => `${windows ? escapeTarget().slice(0, 2) : 'C:'}escaped-rel.txt`],
    [
      windows ? 'as a \\\\?\\ device path' : 'with a doubled leading backslash',
      () => (windows ? `\\\\?\\${escapeTarget()}` : `\\${escapeTarget().replace(/\//g, '\\')}`),
    ],
    // posix reads `//x` as `/x`, which a broken check would write into the sandbox
    [windows ? 'as a \\\\.\\ device path' : 'with a doubled leading slash', () => (windows ? `\\\\.\\${escapeTarget()}` : `/${escapeTarget()}`)],
  ];

  for (const [label, name] of absoluteNames) {
    it(`refuses an absolute name ${label}`, async () => {
      await expectRefused([{ name: name(), data: 'x' }], name(), /is an absolute path/);
    });
  }

  // Checked on the pure function only: an archive with this name would make a broken check open a network share.
  it('refuses a UNC name', () => {
    const entry: ArchiveEntry = { path: '\\\\escape.invalid\\share\\x', type: 'File', externalFileAttributes: 0, flags: 0, compressionMethod: 0 };
    expect(() => archiveEntryTarget('a.zip', guard().destination, entry)).to.throw(IOFail, /is an absolute path/);
  });

  for (const name of ['../escaped-dir/', 'sub/../../escaped-dir/', '..\\escaped-dir\\']) {
    it(`refuses the directory entry ${name}, which resolves outside the destination`, async () => {
      await expectRefused([{ name, data: '' }], name, /resolves outside the destination/);
    });
  }

  it('writes an entry to its central directory name, never to its local header name', async () => {
    await unzip([{ name: 'ok.txt', localName: '../escaped.txt', data: 'payload' }]);

    expect(await tree(provider, '', ['archives'])).to.deep.equal(['outside/', 'outside/dest/', 'outside/dest/ok.txt']);
    expect(await provider.read('outside/dest/ok.txt', 'utf8')).to.equal('payload');
  });

  it('refuses an encrypted entry before it writes any', async () => {
    await expectRefused(
      [
        { name: 'good.txt', data: 'good' },
        { name: 'secret.txt', data: 'ciphertext', flags: 0x1 },
      ],
      'secret.txt',
      /is encrypted/,
    );
  });

  it('refuses an entry with an unsupported compression method before it writes any', async () => {
    await expectRefused(
      [
        { name: 'good.txt', data: 'good' },
        { name: 'packed.txt', data: 'x', method: 12 },
      ],
      'packed.txt',
      /compression method 12/,
    );
  });

  it('removes the entry whose write fails, keeping the entries written before it', async () => {
    await expect(
      unzip([
        { name: 'good.txt', data: 'good' },
        { name: 'broken.txt', data: Buffer.alloc(64, 0xff), method: 8 },
      ]),
    ).to.be.rejectedWith(IOFail, 'cannot write entry "broken.txt"');

    expect(await tree(provider, '', ['archives'])).to.deep.equal(['outside/', 'outside/dest/', 'outside/dest/good.txt']);
  });

  describe('archive comment and trailing bytes', () => {
    for (const length of [0, 58, 59, 1000, 0xffff]) {
      it(`extracts an archive with a ${length}-byte comment`, async () => {
        await provider.write('archives/a.zip', zipArchive([{ name: 'a.txt', data: 'a' }], guard(), { comment: Buffer.alloc(length, 0x63) }));
        await provider.unzip('archives/a.zip', DEST, provider);

        expect(await provider.read('outside/dest/a.txt', 'utf8')).to.equal('a');
      });
    }

    it('takes the last real end record when the comment holds its signature', async () => {
      const fake = Buffer.concat([Buffer.alloc(150, 0x63), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(46, 0x63)]);
      await provider.write('archives/a.zip', zipArchive([{ name: 'a.txt', data: 'a' }], guard(), { comment: fake }));
      await provider.unzip('archives/a.zip', DEST, provider);

      expect(await provider.read('outside/dest/a.txt', 'utf8')).to.equal('a');
    });

    it('extracts an archive followed by trailing bytes', async () => {
      await provider.write('archives/a.zip', Buffer.concat([zipArchive([{ name: 'a.txt', data: 'a' }], guard()), Buffer.alloc(100, 0x74)]));
      await provider.unzip('archives/a.zip', DEST, provider);

      expect(await provider.read('outside/dest/a.txt', 'utf8')).to.equal('a');
    });
  });

  describe('links already inside the destination', () => {
    it('refuses an entry whose parent is a junction pointing outside the destination', async () => {
      await provider.mkdir(DEST);
      await provider.mkdir('outside/junction-target');
      await junction(guard(), join(sandbox, 'outside', 'junction-target'), join(sandbox, 'outside', 'dest', 'j'));

      await expect(unzip([{ name: 'j/evil.txt', data: 'x' }])).to.be.rejectedWith(IOFail, /entry "j\/evil.txt" .*outside the destination/);
      expect(await provider.list('outside/junction-target')).to.deep.equal([]);
    });

    it('writes below a junction that points inside the destination', async () => {
      await provider.mkdir('outside/dest/real');
      await junction(guard(), join(sandbox, 'outside', 'dest', 'real'), join(sandbox, 'outside', 'dest', 'j'));

      await unzip([{ name: 'j/inner.txt', data: 'inner' }]);

      expect(await provider.read('outside/dest/real/inner.txt', 'utf8')).to.equal('inner');
    });

    it('refuses an entry whose own target is a link', async () => {
      await provider.mkdir('outside/dest/real');
      await junction(guard(), join(sandbox, 'outside', 'dest', 'real'), join(sandbox, 'outside', 'dest', 'j'));

      await expect(unzip([{ name: 'j/', data: '' }])).to.be.rejectedWith(IOFail, /entry "j\/" is a link on disk/);
    });

    it('extracts into a destination that is itself reached through a junction', async () => {
      await provider.mkdir('outside/real-dest');
      await junction(guard(), join(sandbox, 'outside', 'real-dest'), join(sandbox, 'outside', 'linked-dest'));
      await provider.write('archives/a.zip', zipArchive([{ name: 'a.txt', data: 'a' }], { root: sandbox, destination: join(sandbox, 'outside', 'linked-dest') }));

      await provider.unzip('archives/a.zip', 'outside/linked-dest', provider);

      expect(await provider.read('outside/real-dest/a.txt', 'utf8')).to.equal('a');
    });
  });

  it('refuses a symbolic link pointing outside and the entry written through it', async () => {
    await expectRefused(
      [
        { name: 'link', data: '..', mode: S_IFLNK | 0o777 },
        { name: 'link/escaped.txt', data: 'x' },
      ],
      'link',
      /is a symbolic link/,
    );
  });

  it('refuses a symbolic link pointing inside the destination', async () => {
    await expectRefused(
      [
        { name: 'a.txt', data: 'a' },
        { name: 'inner', data: 'a.txt', mode: S_IFLNK | 0o777 },
      ],
      'inner',
      /is a symbolic link/,
    );
  });

  it('refuses an entry that is neither a file nor a directory', async () => {
    await expectRefused([{ name: 'fifo', data: '', mode: 0o010644 }], 'fifo', /is not a regular file or directory/);
  });

  const invalidNames = ['a\0b.txt', 'escaped.txt.', 'escaped.txt ', '.. /escaped.txt', '.../escaped.txt', 'a.txt:stream'];

  for (const name of invalidNames) {
    it(`refuses ${JSON.stringify(name)}, a name the fs path rules refuse`, async () => {
      await expectRefused([{ name, data: 'x' }], name, /is not a valid fs path/);
    });
  }

  it('extracts device names as plain files inside the destination', async () => {
    await unzip([
      { name: 'CON', data: 'c' },
      { name: 'NUL', data: 'n' },
      { name: 'aux.txt', data: 'a' },
    ]);

    expect(await tree(provider, '', ['archives'])).to.deep.equal(['outside/', 'outside/dest/', 'outside/dest/CON', 'outside/dest/NUL', 'outside/dest/aux.txt']);
    expect(await provider.read('outside/dest/NUL', 'utf8')).to.equal('n');
  });

  it('writes two names that differ only by case inside the destination, the later one last', async () => {
    await unzip([
      { name: 'Case.txt', data: 'upper' },
      { name: 'case.txt', data: 'lower' },
    ]);

    expect(await tree(provider, '', ['archives', DEST])).to.deep.equal(['outside/']);
    expect(await provider.read('outside/dest/case.txt', 'utf8')).to.equal('lower');
  });

  it('extracts a normal archive byte for byte', async () => {
    const binary = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
    const out = await unzip([
      { name: 'a.txt', data: 'a' },
      { name: 'dir/', data: '' },
      { name: 'dir/b.bin', data: binary },
      { name: 'dir/sub/../c.txt', data: 'c' },
      { name: '...data', data: 'dots' },
    ]);

    expect(out).to.equal(join(sandbox, 'outside', 'dest'));
    expect(await tree(provider, DEST)).to.deep.equal(['outside/dest/...data', 'outside/dest/a.txt', 'outside/dest/dir/', 'outside/dest/dir/b.bin', 'outside/dest/dir/c.txt']);
    expect(await provider.read('outside/dest/dir/b.bin')).to.deep.equal(binary);
    expect(await provider.read('outside/dest/dir/c.txt', 'utf8')).to.equal('c');
  });

  it('extracts every entry of an archive with many entries', async function () {
    this.timeout(120000);
    const entries = Array.from({ length: 200 }, (_, i) => ({ name: `d${i % 10}/f${i}.txt`, data: `file ${i}` }));
    await unzip(entries);

    expect((await tree(provider, DEST)).filter((p) => !p.endsWith('/'))).to.have.length(200);
    expect(await provider.read('outside/dest/d9/f199.txt', 'utf8')).to.equal('file 199');
  });

  it('rejects, naming the destination, when the destination is a file', async function () {
    this.timeout(10000);
    await provider.write(DEST, 'a file');

    await expect(unzip([{ name: 'a.txt', data: 'a' }])).to.be.rejectedWith(IOFail, `cannot create the destination ${join(sandbox, 'outside', 'dest')}`);
    expect(await provider.read(DEST, 'utf8')).to.equal('a file');
  });

  it('rejects, naming the entry, when an entry lies below another entry that is a file', async function () {
    this.timeout(10000);

    await expect(
      unzip([
        { name: 'a', data: 'file' },
        { name: 'a/b', data: 'below a file' },
      ]),
    ).to.be.rejectedWith(IOFail, 'cannot write entry "a/b"');
    expect(await tree(provider, '', ['archives', DEST])).to.deep.equal(['outside/']);
  });

  it('writes no entry of an archive that holds one bad entry among good ones', async () => {
    await expectRefused(
      [
        { name: 'first.txt', data: 'first' },
        { name: 'dir/second.txt', data: 'second' },
        { name: '../escaped.txt', data: 'x' },
        { name: 'last.txt', data: 'last' },
      ],
      '../escaped.txt',
      /resolves outside the destination/,
    );
  });

  it("does not write into another tenant's prefix", async () => {
    const acme = await local('acme', join(sandbox, 'tenants', 'acme'));
    const name = '../../../globex/x.txt';
    await acme.write('a.zip', zipArchive([{ name, data: 'x' }], { root: sandbox, destination: join(sandbox, 'tenants', 'acme', 'uploads', 'in') }));

    await expect(acme.unzip('a.zip', 'uploads/in', acme)).to.be.rejectedWith(IOFail, JSON.stringify(name));
    expect(await tree(provider, 'tenants')).to.deep.equal(['tenants/acme/', 'tenants/acme/a.zip']);
  });

  it('streams a large archive instead of holding it in memory', async function () {
    this.timeout(300000);
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    const times = 128;
    await finished(await provider.writeStream('archives/large.zip', Readable.from(largeZip(guard(), 'large.bin', chunk, times))));

    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 5);

    try {
      await provider.unzip('archives/large.zip', DEST, provider);
    } finally {
      clearInterval(sampler);
    }

    const expected = createHash('sha256');
    for (let i = 0; i < times; i++) expected.update(chunk);

    expect(await sha256(provider, 'outside/dest/large.bin')).to.equal(expected.digest('hex'));
    // Streamed chunks are garbage V8 collects at about 64 MiB of external memory; a buffered archive keeps all 128 MiB alive.
    expect(peak - before, `peak arrayBuffers grew by ${peak - before} bytes`).to.be.lessThan(96 * 1024 * 1024);
  });
});
