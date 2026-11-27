import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { DI } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { FsMiddleware, FsProviderLayer, URI, _read, copy as copyHelper, fsService, getFs, layeredFs, publishedFs, read as readHelper } from '@spinajs/fs';
import type { FsActionContext, fs } from '@spinajs/fs';
import { Log } from '@spinajs/log-common';
import type { ILogEntry } from '@spinajs/log-common';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { TenantRequired, runAcrossTenants, runInTenant } from '../src/index.js';
import { TenantFs, TenantFsGuard, TenantFsLayer } from '../src/fs.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const root = join(tmpdir(), `v4-ta-05b-tenant-fs-${process.pid}`);
const uploads = join(root, 'uploads');
const docs = join(root, 'docs');
const bucket = join(root, 'bucket');
const other = join(root, 'other');
const PROVIDERS = [
  { service: 'fsNative', name: 'uploads', basePath: uploads },
  { service: 'fsNative', name: 'docs', basePath: docs },
  { service: 'fsNative', name: 'bucket', basePath: bucket },
  { service: 'fsNative', name: 'other', basePath: other },
];

class SilentLog extends Log {
  public trace(): void {}
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public fatal(): void {}
  public security(): void {}
  public success(): void {}
  public write(_entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    return Promise.resolve([]);
  }
}

class Recorder extends FsMiddleware {
  public static seen: string[] = [];

  public override order = 1;

  public before(ctx: FsActionContext): Promise<void> {
    Recorder.seen.push(...ctx.targets.map((target) => `${target.fs.Name}:${target.path}`));
    return Promise.resolve();
  }
}

const tenantRoot = (tenant: string, base = uploads) => join(base, 'tenants', tenant);
const tenantFile = (tenant: string, file: string) => join(tenantRoot(tenant), file);

function boot(tenancy: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<TestApp> {
  for (const dir of [uploads, docs, bucket, other]) mkdirSync(dir, { recursive: true });
  return createTestApp({
    config: { tenancy: { fs: tenancy }, fs: { defaultProvider: 'other', providers: PROVIDERS }, ...extra },
    register: (container) => container.register(SilentLog).as(Log),
    resolve: [fsService],
  });
}

/** A stored zip archive whose entry names are taken as written, '../' included. */
function zipOf(entries: Record<string, string>): Buffer {
  const header = (size: number, fields: Array<[number, number, 2 | 4]>): Buffer => {
    const out = Buffer.alloc(size);
    for (const [at, value, bytes] of fields) (bytes === 4 ? out.writeUInt32LE(value, at) : out.writeUInt16LE(value, at));
    return out;
  };
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const [data, file, offset] = [Buffer.from(text), Buffer.from(name), Buffer.concat(parts).length];
    const sizes: Array<[number, number, 2 | 4]> = [[4, 20, 2], [14, crc32(data), 4], [18, data.length, 4], [22, data.length, 4], [26, file.length, 2]];
    parts.push(header(30, [[0, 0x04034b50, 4], ...sizes]), file, data);
    central.push(header(46, [[0, 0x02014b50, 4], [6, 20, 2], ...sizes.map(([at, v, b]): [number, number, 2 | 4] => [at + 2, v, b]), [42, offset, 4]]), file);
  }
  const directory = Buffer.concat(central);
  const count = central.length / 2;
  const end = header(22, [[0, 0x06054b50, 4], [8, count, 2], [10, count, 2], [12, directory.length, 4], [16, Buffer.concat(parts).length, 4]]);
  return Buffer.concat([...parts, directory, end]);
}

/** Every file and directory under `dir` with its content, except `skip`. */
function tree(dir: string, skip: string): string {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (path === skip) continue;
      out.push(entry.isDirectory() ? `${path}/` : `${path}=${readFileSync(path, 'utf-8')}`);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

const drain = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    let text = '';
    stream.on('data', (chunk) => (text += String(chunk)));
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });

const finish = (stream: Awaited<ReturnType<fs['writeStream']>>, data: string) =>
  new Promise<void>((resolve, reject) => {
    stream.on('close', () => resolve());
    stream.on('error', reject);
    stream.end(data);
  });

const OWN = join(root, 'local-src.txt');

/** Every public action of the provider interface, with the hostile path in each path argument. */
const OPERATIONS: Record<string, (f: fs, p: string) => Promise<unknown>> = {
  read: (f, p) => f.read(p, 'utf-8'),
  readStream: async (f, p) => drain(await f.readStream(p)),
  write: (f, p) => f.write(p, 'w'),
  append: (f, p) => f.append(p, 'a'),
  writeStream: async (f, p) => finish(await f.writeStream(p), 'ws'),
  exists: (f, p) => f.exists(p),
  dirExists: (f, p) => f.dirExists(p),
  isDir: (f, p) => f.isDir(p),
  stat: (f, p) => f.stat(p),
  list: (f, p) => f.list(p),
  hasEntries: (f, p) => f.hasEntries(p),
  mkdir: (f, p) => f.mkdir(p),
  rm: (f, p) => f.rm(p),
  hash: (f, p) => f.hash(p),
  download: (f, p) => f.download(p),
  upload: (f, p) => f.upload(OWN, p),
  copyFrom: (f, p) => f.copy(p, 'out.txt'),
  copyTo: (f, p) => f.copy('own.txt', p),
  moveFrom: (f, p) => f.move(p, 'out.txt'),
  moveTo: (f, p) => f.move('own.txt', p),
  renameFrom: (f, p) => f.rename(p, 'out.txt'),
  renameTo: (f, p) => f.rename('own.txt', p),
  zip: (f, p) => f.zip(p, getFs('other'), 'z.zip'),
  unzipFrom: (f, p) => f.unzip(p, 'unzipped'),
  unzipTo: (f, p) => f.unzip('own.zip', p),
  signedUrl: (f, p) => f.signedUrl(p),
  resolvePath: (f, p) => Promise.resolve().then(() => f.resolvePath(p)),
};

const CLIMBS = ['../beta/secret.txt', 'a/../../beta/secret.txt', '..\\beta\\secret.txt', '../../../uploads/tenants/beta/secret.txt', 'x\0.txt', 'C:\\Windows\\win.ini'];
const MAPPED = ['/tenants/beta/secret.txt', '\\tenants\\beta\\secret.txt', join(uploads, 'tenants', 'beta', 'secret.txt'), '%2e%2e/beta/secret.txt', '\uff0e\uff0e/beta/secret.txt', '\u2025/beta/secret.txt', '', '.', '/'];

describe('files per tenant', function () {
  this.timeout(180000);
  let app: TestApp;

  before(async () => {
    DI.register(Recorder).as(FsMiddleware);
    app = await boot({ prefixed: ['uploads', 'docs'], dedicated: { uploads: { bigcorp: 'bucket' } } });
    DI.uncache(Array.ofType(FsMiddleware));
  });

  after(async () => {
    await app?.dispose();
    DI.unregister(Recorder);
    DI.uncache(Array.ofType(FsMiddleware));
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    Recorder.seen = [];
  });

  it("stores a file under the tenant's prefix; another tenant does not see it", async () => {
    await runInTenant('alpha', () => getFs('uploads').write('logo.png', 'alpha logo'));

    expect(readFileSync(tenantFile('alpha', 'logo.png'), 'utf-8')).to.equal('alpha logo');
    expect(await runInTenant('alpha', () => getFs('uploads').read('logo.png', 'utf-8'))).to.equal('alpha logo');
    expect(await runInTenant('alpha', () => getFs('uploads').list(''))).to.deep.equal(['logo.png']);
    expect(await runInTenant('beta', () => getFs('uploads').exists('logo.png'))).to.equal(false);
    await publishedFs('uploads')!.rm('tenants/alpha');
    await runInTenant('alpha', () => getFs('uploads').write('again.txt', 'again'));
    expect(await runInTenant('alpha', () => getFs('uploads').list(''))).to.deep.equal(['again.txt']);
  });

  it('refuses an action with no tenant scope and across all tenants, before any other middleware', async () => {
    await expect(getFs('uploads').write('x.txt', 'x')).to.be.rejectedWith(TenantRequired);
    await expect(runAcrossTenants('backup', () => getFs('uploads').list(''))).to.be.rejectedWith(TenantRequired);

    expect(Recorder.seen).to.deep.equal([]);
  });

  it("a path cannot leave the tenant's prefix", async () => {
    await expect(runInTenant('alpha', () => getFs('uploads').write('../beta/x.txt', 'x'))).to.be.rejectedWith(InvalidArgument);

    await runInTenant('alpha', () => getFs('uploads').mkdir('tenants/beta'));
    await runInTenant('alpha', () => getFs('uploads').write('/tenants/beta/y.txt', 'y'));

    expect(existsSync(join(uploads, 'tenants', 'alpha', 'tenants', 'beta', 'y.txt'))).to.equal(true);
    expect(existsSync(tenantFile('beta', 'y.txt'))).to.equal(false);

    await expect(runInTenant('alpha', async () => getFs('uploads').resolvePath('../beta/y.txt'))).to.be.rejectedWith(InvalidArgument);
    const inside = await runInTenant('alpha', async () => getFs('uploads').resolvePath('docs/../y.txt'));
    expect(inside).to.equal(join(uploads, 'tenants', 'alpha', 'y.txt'));
  });

  it('a tenant with a dedicated provider writes there, without a prefix', async () => {
    await runInTenant('bigcorp', () => getFs('uploads').write('logo.png', 'big'));

    expect(readFileSync(join(bucket, 'logo.png'), 'utf-8')).to.equal('big');
    await runInTenant('bigcorp', () => getFs('uploads').zip('logo.png', getFs('other'), 'big.zip'));
    expect(readFileSync(join(await getFs('other').unzip('big.zip', 'big-unzipped'), 'logo.png'), 'utf-8')).to.equal('big');
  });

  it('hands out a provider that is not listed as published, and one view per listed provider', () => {
    expect(getFs('other')).to.equal(publishedFs('other'));
    expect(getFs('uploads')).to.be.instanceOf(TenantFs);
    expect(getFs('uploads')).to.equal(getFs('uploads'));
    // outside any tenant scope: @spinajs/authz-fs refuses the file ACL of a provider layeredFs hands out as another (branch 7a)
    expect(layeredFs(publishedFs('uploads')!)).to.equal(getFs('uploads')).and.not.equal(publishedFs('uploads'));
    expect(publishedFs('uploads')).to.not.be.instanceOf(TenantFs);
    expect(publishedFs('uploads')!.BasePath).to.equal(resolve(uploads));
  });

  it('refuses every lookup by name while a listed provider is guarded by authz-fs, in audit and in enforce mode', () => {
    try {
      app.config.set('authz.fs', { uploads: { mode: 'enforce' } });
      // the way out it names is another provider, never mode "off": FsAcl and relation checks reach the ACL in every mode
      expect(() => getFs('other')).to.throw(/tenancy\.fs\.prefixed lists "uploads".*authz\.fs\.uploads\.mode is "enforce".*on a provider that is not listed in tenancy\.fs\.prefixed\.$/);
      app.config.set('authz.fs', { uploads: { mode: 'audit' } });
      expect(() => getFs('uploads')).to.throw(/authz\.fs\.uploads\.mode is "audit"/);

      app.config.set('authz.fs', { uploads: { mode: 'off' }, other: { mode: 'enforce' } });
      expect(getFs('uploads')).to.be.instanceOf(TenantFs);
      expect(getFs('other')).to.equal(publishedFs('other'));

      // a nested set changes the authz.fs object in place (_.set, configuration/src/configuration.ts:246)
      app.config.set('authz.fs.uploads.mode', 'enforce');
      expect(() => getFs('uploads')).to.throw(/authz\.fs\.uploads\.mode is "enforce"/);
    } finally {
      app.config.set('authz.fs', {});
    }
  });

  it('every operation with a hostile path is refused or stays in the tenant, and shows nothing of another', async () => {
    await runInTenant('beta', async () => {
      await getFs('uploads').write('secret.txt', 'BETA-SECRET');
      await getFs('uploads').write('zz-beta-marker.txt', 'BETA-SECRET');
    });
    writeFileSync(OWN, 'local');
    const betaRoot = tenantRoot('beta');
    const before = tree(root, tenantRoot('alpha'));
    const failures: string[] = [];
    for (const [name, operation] of Object.entries(OPERATIONS)) {
      for (const path of [...CLIMBS, ...MAPPED]) {
        rmSync(tenantRoot('alpha'), { recursive: true, force: true });
        mkdirSync(tenantRoot('alpha'), { recursive: true });
        writeFileSync(tenantFile('alpha', 'own.txt'), 'own');
        writeFileSync(tenantFile('alpha', 'own.zip'), zipOf({ 'a.txt': 'A' }));
        const outcome = await runInTenant('alpha', () => operation(getFs('uploads'), path)).then(
          (value: unknown) => ({ value }),
          (error: unknown) => ({ error }),
        );
        rmSync(join(other, 'z.zip'), { force: true });
        const shown = 'error' in outcome ? String(outcome.error instanceof Error ? outcome.error.message : outcome.error) : JSON.stringify(outcome.value) ?? '';
        const label = `${name}(${JSON.stringify(path)})`;
        if (CLIMBS.includes(path) && !('error' in outcome && outcome.error instanceof InvalidArgument)) failures.push(`${label} was not refused`);
        if (/BETA-SECRET|zz-beta-marker/.test(shown) || (!path.includes(betaRoot) && shown.includes(betaRoot))) failures.push(`${label} showed ${shown}`);
        if (name === 'resolvePath' && 'value' in outcome && !String(outcome.value).startsWith(tenantRoot('alpha'))) failures.push(`${label} resolved to ${String(outcome.value)}`);
        if (tree(root, tenantRoot('alpha')) !== before) failures.push(`${label} changed files outside the tenant`);
      }
    }
    expect(failures).to.deep.equal([]);
  });

  it('a symbolic link below a tenant root never leads to another tenant', async () => {
    await runInTenant('beta', () => getFs('uploads').write('secret.txt', 'BETA-SECRET'));
    mkdirSync(tenantRoot('alpha'), { recursive: true });
    const link = join(tenantRoot('alpha'), 'link');
    symlinkSync(tenantRoot('beta'), link, 'junction');
    symlinkSync(tenantRoot('beta'), tenantRoot('delta'), 'junction');
    await runInTenant('alpha2', () => getFs('uploads').write('x.txt', 'ALPHA2'));
    symlinkSync(tenantRoot('alpha2'), join(tenantRoot('alpha'), 'l2'), 'junction');
    try {
      for (const [tenant, path] of [['alpha', 'link/secret.txt'], ['alpha', 'link'], ['delta', 'secret.txt'], ['delta', ''], ['alpha', 'l2/x.txt']]) {
        const files = () => getFs('uploads');
        await expect(runInTenant(tenant, () => files().read(path, 'utf-8'))).to.be.rejectedWith(InvalidArgument, /symbolic link/);
        await expect(runInTenant(tenant, () => files().write(join(path, 'w.txt'), 'w'))).to.be.rejectedWith(InvalidArgument, /symbolic link/);
        await expect(runInTenant(tenant, () => files().list(path))).to.be.rejectedWith(InvalidArgument, /symbolic link/);
        await expect(runInTenant(tenant, () => files().rm(path))).to.be.rejectedWith(InvalidArgument, /symbolic link/);
        await expect(runInTenant(tenant, async () => files().resolvePath(path))).to.be.rejectedWith(InvalidArgument, /symbolic link/);
      }
    } finally {
      for (const made of [link, tenantRoot('delta'), join(tenantRoot('alpha'), 'l2')]) rmSync(made, { force: true });
    }
    expect(readFileSync(tenantFile('beta', 'secret.txt'), 'utf-8')).to.equal('BETA-SECRET');
  });

  it('copy and move between providers confine each side on its own; a shared side of a listed provider is refused in a tenant', async () => {
    await runInTenant('beta', () => getFs('uploads').write('secret.txt', 'BETA-SECRET'));
    await runInTenant('alpha', async () => {
      const [up, doc, shared] = [getFs('uploads'), getFs('docs'), getFs('other')];
      await up.write('a.txt', 'A');
      await up.copy('a.txt', 'kept.txt', doc);
      await up.copy('a.txt', 'to-docs.txt', doc);
      await up.copy('a.txt', 'to-other.txt', shared);
      await shared.move('to-other.txt', 'back.txt', up);
      await doc.move('to-docs.txt', 'moved.txt', up);

      await expect(up.copy('a.txt', 'raw.txt', publishedFs('uploads'))).to.be.rejectedWith(InvalidOperation, /without the tenant's view/);
      await expect(up.move('a.txt', 'raw.txt', publishedFs('uploads'))).to.be.rejectedWith(InvalidOperation, /without the tenant's view/);
      await expect(shared.copy('back.txt', 'raw.txt', publishedFs('docs'))).to.be.rejectedWith(InvalidOperation);
      await expect(publishedFs('uploads')!.write('raw.txt', 'x')).to.be.rejectedWith(InvalidOperation);
      await expect(up.upload(tenantFile('beta', 'secret.txt'), 'stolen.txt')).to.be.rejectedWith(InvalidArgument, /outside this tenant's own/);
    });

    expect(readFileSync(join(tenantRoot('alpha', docs), 'kept.txt'), 'utf-8')).to.equal('A');
    expect(existsSync(join(tenantRoot('alpha', docs), 'to-docs.txt'))).to.equal(false);
    expect(readFileSync(tenantFile('alpha', 'back.txt'), 'utf-8')).to.equal('A');
    expect(readFileSync(tenantFile('alpha', 'moved.txt'), 'utf-8')).to.equal('A');
    expect(existsSync(join(other, 'to-other.txt'))).to.equal(false);
    for (const raw of [join(uploads, 'raw.txt'), join(docs, 'raw.txt'), tenantFile('alpha', 'stolen.txt')]) expect(existsSync(raw)).to.equal(false);
  });

  it("a dedicated provider is refused by its own name in every tenant, its owner's included, by an instance taken in its owner's scope and as a destination", async () => {
    await runInTenant('bigcorp', () => getFs('uploads').write('logo.png', 'BIG'));
    const earlier = await runInTenant('bigcorp', async () => getFs('bucket'));
    writeFileSync(OWN, 'local');
    writeFileSync(join(other, 'good.zip'), zipOf({ 'g.txt': 'G' }));
    const before = tree(bucket, '');
    const failures: string[] = [];
    // resolvePath is no action: it answers a path string, and an upload() from it is refused (assertOwnSource)
    for (const [name, operation] of Object.entries(OPERATIONS).filter(([op]) => op !== 'resolvePath')) {
      for (const files of [() => getFs('bucket'), () => earlier]) {
        const outcome = await runInTenant('alpha', () => operation(files(), 'logo.png')).then(() => 'resolved', (error: unknown) => error);
        if (!(outcome instanceof InvalidOperation)) failures.push(`${name}: ${String(outcome)}`);
      }
    }
    await runInTenant('alpha', async () => {
      const [up, shared, theirs] = [getFs('uploads'), getFs('other'), getFs('bucket')];
      await up.write('a.txt', 'A');
      const writes = [() => up.copy('a.txt', 'c.txt', theirs), () => up.move('a.txt', 'c.txt', theirs), () => up.zip('a.txt', theirs, 'z.zip'), () => shared.unzip('good.zip', 'u', theirs), () => shared.copy('good.zip', 'c.zip', theirs)];
      for (const write of writes) await expect(write()).to.be.rejectedWith(InvalidOperation, /without the tenant's view/);
      for (const read of [() => readHelper('logo.png', 'utf-8', 'bucket'), () => _read('logo.png', 'utf-8', 'bucket'), () => new URI('fs://bucket/logo.png').Fs.read('logo.png'), () => publishedFs('bucket')!.list(''), () => copyHelper('a.txt', 'c.txt', up, 'bucket')]) await expect(read()).to.be.rejectedWith(InvalidOperation);
      expect(await getFs('uploads').exists('logo.png')).to.equal(false);
      await expect(up.upload(join(bucket, 'logo.png'), 'stolen.png')).to.be.rejectedWith(InvalidArgument, /outside this tenant's own/);
    });
    expect(failures).to.deep.equal([]);
    expect(tree(bucket, '')).to.equal(before);
    for (const raw of [() => getFs('bucket').read('logo.png', 'utf-8'), () => getFs('bucket').upload(tenantFile('beta', 'secret.txt'), 'x'), () => getFs('bucket').unzip('good.zip', '')]) await expect(runInTenant('bigcorp', async () => { await raw(); })).to.be.rejectedWith(InvalidOperation);
    expect(await getFs('bucket').read('logo.png', 'utf-8')).to.equal('BIG');
  });

  it('an archive of one tenant cannot write into another, also a tenant whose id its own prefixes', async () => {
    const evil = zipOf({ '../acme2/slip.txt': 'X', '../../escape.txt': 'X', 'ok/inner.txt': 'OK' });
    writeFileSync(join(other, 'evil.zip'), evil);
    await runInTenant('acme2', () => getFs('uploads').write('mine.txt', 'acme2'));
    await runInTenant('acme', async () => {
      const up = getFs('uploads');
      await up.write('evil.zip', evil);
      await expect(up.unzip('evil.zip', '')).to.be.rejectedWith(InvalidOperation, /below the tenant's root/);
      await expect(getFs('other').unzip('evil.zip', '/', up)).to.be.rejectedWith(InvalidOperation, /below the tenant's root/);
      await up.unzip('evil.zip', 'x');
      expect(await up.exists('mine.txt')).to.equal(false);
      expect(await up.list('')).to.have.members(['evil.zip', 'x']);
    });

    expect(readFileSync(join(tenantRoot('acme'), 'x', 'ok', 'inner.txt'), 'utf-8')).to.equal('OK');
    expect(readdirSync(tenantRoot('acme2'))).to.deep.equal(['mine.txt']);
    expect(existsSync(join(uploads, 'tenants', 'escape.txt'))).to.equal(false);
  });

  it('refuses every lookup while a layer registered after TenantFsLayer could hand out the shared provider', async () => {
    class Later extends FsProviderLayer {
      public wrap(provider: fs): fs { return publishedFs(provider.Name) ?? provider; }
    }
    DI.register(Later).as(FsProviderLayer);
    try {
      expect(() => getFs('uploads')).to.throw(InvalidOption, /FsProviderLayer Later is registered after TenantFsLayer/);
      await expect(runInTenant('alpha', () => getFs('docs').write('later.txt', 'x'))).to.be.rejected;
    } finally {
      DI.unregister(Later);
      DI.uncache(Array.ofType(FsProviderLayer));
    }
    expect(getFs('uploads')).to.be.instanceOf(TenantFs);
  });

  it('refuses an action on a listed provider while another class took the name TenantFsLayer', async () => {
    const impostor = { TenantFsLayer: class extends FsProviderLayer {
      public wrap(provider: fs): fs { return provider; }
    } }.TenantFsLayer;
    // DI caches singletons by class name: the impostor would get the real layer's instance.
    DI.unregister(TenantFsLayer);
    DI.uncache(TenantFsLayer);
    DI.register(impostor).as(FsProviderLayer);
    DI.uncache(Array.ofType(FsProviderLayer));
    try {
      await expect(getFs('uploads').write('impostor.txt', 'x')).to.be.rejectedWith(InvalidOption, /registers no TenantFsLayer/);
      await expect(runInTenant('alpha', () => getFs('uploads').write('impostor.txt', 'x'))).to.be.rejectedWith(InvalidOption);
    } finally {
      DI.unregister(impostor);
      DI.uncache(impostor);
      DI.register(TenantFsLayer).as(FsProviderLayer);
      DI.uncache(Array.ofType(FsProviderLayer));
    }
    expect(existsSync(join(uploads, 'impostor.txt'))).to.equal(false);
    expect(getFs('uploads')).to.be.instanceOf(TenantFs);
  });

  it('a TenantFs refuses an action with no tenant scope also when TenantFsGuard does not run', async () => {
    DI.unregister(TenantFsGuard);
    DI.uncache(Array.ofType(FsMiddleware));
    try {
      await expect(getFs('uploads').write('unguarded.txt', 'x')).to.be.rejectedWith(TenantRequired);
    } finally {
      DI.register(TenantFsGuard).as(FsMiddleware);
      DI.uncache(Array.ofType(FsMiddleware));
    }
    expect(existsSync(join(uploads, 'unguarded.txt'))).to.equal(false);
  });

  it('refuses a listed provider that the framework uses outside any tenant, and a dedicated provider that is not one tenant’s own', () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['upload.fs', { temp: 'other', files: 'uploads' }, /"uploads", which the framework uses outside any tenant scope: upload\.fs\.files names it/],
      ['email.templateFs', 'docs', /email\.templateFs names it/],
      ['logger.targets', [{ name: 'file', type: 'FileTarget', options: { fs: 'other', archiveFs: 'uploads' } }], /logger\.targets\[0\]\.options\.archiveFs/],
      ['fs.providers', [...PROVIDERS, { service: 'fsTemp', name: 'tmp-docs', provider: 'docs' }], /backend of the temporary file system "tmp-docs"/],
      ['tenancy.fs.prefixed', ['uploads', '__fs_http_response_templates__'], /starts with __fs_/],
      ['tenancy.fs.dedicated', { uploads: { bigcorp: 'docs' } }, /names "docs", which tenancy\.fs\.prefixed lists/],
      ['tenancy.fs.dedicated', { uploads: { bigcorp: 'bucket' }, docs: { megacorp: 'bucket' } }, /dedicated to the tenant "bigcorp" too/],
    ];
    for (const [path, value, refusal] of cases) {
      const before: unknown = app.config.get(path);
      try {
        app.config.set(path, value);
        expect(() => getFs('other'), path).to.throw(InvalidOption, refusal);
      } finally {
        app.config.set(path, before);
      }
    }
    const layer = DI.resolve(TenantFsLayer);
    // plain JavaScript can hand wrap() anything; a promise passed on would skip the next layer
    expect(() => {
      Reflect.apply(layer.wrap.bind(layer), undefined, [Promise.resolve(publishedFs('uploads'))]);
    }).to.throw(InvalidOperation, /takes an fs provider/);
    expect(getFs('uploads')).to.be.instanceOf(TenantFs);
  });
});

describe('files per tenant: the configuration at boot', function () {
  this.timeout(60000);

  after(() => rmSync(root, { recursive: true, force: true }));

  it('a listed provider that @spinajs/upload writes through publishedFs() fails the boot', async () => {
    await expect(boot({ prefixed: ['uploads'] }, { upload: { fs: { temp: 'other', files: 'uploads' } } })).to.be.rejectedWith(InvalidOption, /upload\.fs\.files names it/);
  });
});
