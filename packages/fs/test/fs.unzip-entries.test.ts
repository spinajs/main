import 'mocha';
import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { IOFail } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';
import { fsNative } from '../src/index.js';
import type { fs, IFsLocalOptions } from '../src/index.js';
import { fsApp } from './common.js';
import { largeZip, S_IFLNK, zipArchive } from './support/zip.js';
import type { ZipEntry } from './support/zip.js';

// Every entry below `path`: directories end in '/'. list() names links too, so a link the unzip made shows up here.
async function tree(f: fs, path: string, skip: string[] = []): Promise<string[]> {
  const out: string[] = [];
  for (const name of await f.list(path || '/')) {
    const p = path ? `${path}/${name}` : name;
    if (skip.includes(p)) continue;
    if (await f.isDir(p)) out.push(`${p}/`, ...(await tree(f, p)));
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

  let n = 0;
  beforeEach(async () => {
    sandbox = join(root.BasePath ?? '', `case-${n++}`);
    provider = await local('unzip-entries', sandbox);
    await provider.mkdir('archives');
    await provider.mkdir('outside');
  });

  async function unzip(entries: ZipEntry[]): Promise<string> {
    await provider.write('archives/a.zip', zipArchive(entries));
    return provider.unzip('archives/a.zip', 'dest', provider);
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

  const absoluteNames: [string, () => string][] = [
    ['/tmp/x', () => '/tmp/x'],
    ['C:\\x', () => 'C:\\x'],
    ['C:/x', () => 'C:/x'],
    ['C:x', () => 'C:x'],
    ['\\\\invalid.invalid\\share\\x', () => '\\\\invalid.invalid\\share\\x'],
    ['an absolute path into the sandbox', () => join(sandbox, 'escaped.txt').replace(/\\/g, '/')],
  ];

  for (const [label, name] of absoluteNames) {
    it(`refuses the absolute name ${label}`, async () => {
      await expectRefused([{ name: name(), data: 'x' }], name(), /is an absolute path/);
    });
  }

  it('refuses a symbolic link pointing outside and the entry written through it', async () => {
    await expectRefused(
      [
        { name: 'link', data: '../outside', mode: S_IFLNK | 0o777 },
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

    expect(await tree(provider, '', ['archives'])).to.deep.equal(['dest/', 'dest/CON', 'dest/NUL', 'dest/aux.txt', 'outside/']);
    expect(await provider.read('dest/NUL', 'utf8')).to.equal('n');
  });

  it('writes two names that differ only by case inside the destination, the later one last', async () => {
    await unzip([
      { name: 'Case.txt', data: 'upper' },
      { name: 'case.txt', data: 'lower' },
    ]);

    expect(await tree(provider, 'outside')).to.deep.equal([]);
    expect(await provider.read('dest/case.txt', 'utf8')).to.equal('lower');
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

    expect(out).to.equal(join(sandbox, 'dest'));
    expect(await tree(provider, 'dest')).to.deep.equal(['dest/...data', 'dest/a.txt', 'dest/dir/', 'dest/dir/b.bin', 'dest/dir/c.txt']);
    expect(await provider.read('dest/dir/b.bin')).to.deep.equal(binary);
    expect(await provider.read('dest/dir/c.txt', 'utf8')).to.equal('c');
  });

  it('extracts every entry of an archive with many entries', async function () {
    this.timeout(120000);
    const entries = Array.from({ length: 200 }, (_, i) => ({ name: `d${i % 10}/f${i}.txt`, data: `file ${i}` }));
    await unzip(entries);

    expect((await tree(provider, 'dest')).filter((p) => !p.endsWith('/'))).to.have.length(200);
    expect(await provider.read('dest/d9/f199.txt', 'utf8')).to.equal('file 199');
  });

  it('rejects, naming the destination, when the destination is a file', async function () {
    this.timeout(10000);
    await provider.write('dest', 'a file');

    await expect(unzip([{ name: 'a.txt', data: 'a' }])).to.be.rejectedWith(IOFail, `cannot create the destination ${join(sandbox, 'dest')}`);
    expect(await provider.read('dest', 'utf8')).to.equal('a file');
  });

  it('rejects, naming the entry, when an entry lies below another entry that is a file', async function () {
    this.timeout(10000);

    await expect(
      unzip([
        { name: 'a', data: 'file' },
        { name: 'a/b', data: 'below a file' },
      ]),
    ).to.be.rejectedWith(IOFail, 'cannot write entry "a/b"');
    expect(await tree(provider, 'outside')).to.deep.equal([]);
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
    await acme.write('a.zip', zipArchive([{ name: '../../globex/x.txt', data: 'x' }]));

    await expect(acme.unzip('a.zip', 'uploads/in', acme)).to.be.rejectedWith(IOFail, '"../../globex/x.txt"');
    expect(await tree(provider, 'tenants')).to.deep.equal(['tenants/acme/', 'tenants/acme/a.zip']);
  });

  it('streams a large archive instead of holding it in memory', async function () {
    this.timeout(300000);
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    const times = 128;
    await finished(await provider.writeStream('archives/large.zip', Readable.from(largeZip('large.bin', chunk, times))));

    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 5);

    try {
      await provider.unzip('archives/large.zip', 'dest', provider);
    } finally {
      clearInterval(sampler);
    }

    const expected = createHash('sha256');
    for (let i = 0; i < times; i++) expected.update(chunk);

    expect(await sha256(provider, 'dest/large.bin')).to.equal(expected.digest('hex'));
    // Streamed chunks are garbage V8 collects at about 64 MiB of external memory; a buffered archive keeps all 128 MiB alive.
    expect(peak - before, `peak arrayBuffers grew by ${peak - before} bytes`).to.be.lessThan(96 * 1024 * 1024);
  });
});
