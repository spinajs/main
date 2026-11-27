import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InvalidArgument } from '@spinajs/exceptions';
import { fsService, getFs, zip } from '@spinajs/fs';
import type { fs } from '@spinajs/fs';
import { Log } from '@spinajs/log-common';
import type { ILogEntry } from '@spinajs/log-common';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { runInTenant } from '../src/index.js';
import '../src/fs.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// Every path below lies under os.tmpdir(); the test runs with TMP / TEMP pointed at a sandbox.
const root = join(tmpdir(), `tenancy-fs-upload-source-${process.pid}`);
const dir = (name: string) => join(root, name);
const beta = join(dir('uploads'), 'tenants', 'beta');
const incoming = dir('incoming');
const betaFile = join(beta, 'secret.txt');

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

// acme (tenant A) has a prefix on uploads and its own vault for docs; beta (B) has a prefix, bigcorp (B) its bucket.
const PROVIDERS = ['uploads', 'docs', 'bucket', 'vault', 'other', 'tmpbase'].map((name) => ({ service: 'fsNative', name, basePath: dir(name) }));

const SECRET: Record<string, string | URL> = {
  'beta prefixed file': join(beta, 'secret.txt'),
  "bigcorp's dedicated folder": join(dir('bucket'), 'big.txt'),
  "a listed provider's shared root": join(dir('uploads'), 'shared.txt'),
  'a junction into beta': join(incoming, 'jbeta', 'secret.txt'),
  // join() would resolve the climb before the upload sees it
  "a '..' climb into beta": [incoming, '..', 'uploads', 'tenants', 'beta', 'secret.txt'].join(sep),
  "a prefix sibling's file (acme2)": join(dir('uploads'), 'tenants', 'acme2', 'a.txt'),
  'a \\\\?\\ spelling': `\\\\?\\${join(beta, 'secret.txt')}`,
  'a file beta does not have': join(beta, 'missing.txt'),
  // it holds every destination too: a check that lets it through makes cp refuse to copy into its own subfolder
  'a folder that holds the providers': root,
  'a file URL': pathToFileURL(join(beta, 'secret.txt')),
};

// The same file of beta through the drive's administrative share, derived from the sandbox's own real path.
function uncSpelling(): string | undefined {
  const real = realpathSync.native(join(beta, 'secret.txt'));
  const drive = /^([A-Za-z]):\\/.exec(real);
  if (process.platform !== 'win32' || drive === null) return undefined;
  const unc = `\\\\localhost\\${drive[1]}$\\${real.slice(3)}`;
  return existsSync(unc) ? unc : undefined;
}

const OWN = {
  "acme's prefixed file": join(dir('uploads'), 'tenants', 'acme', 'mine.txt'),
  "acme's dedicated vault": join(dir('vault'), 'own.txt'),
  'an OS temp upload folder': join(incoming, 'upload-1.bin'),
};

describe('files per tenant: the local source of an upload', function () {
  this.timeout(120000);
  let app: TestApp;

  before(async () => {
    for (const name of [...PROVIDERS.map((p) => p.name), 'incoming']) mkdirSync(dir(name), { recursive: true });
    mkdirSync(beta, { recursive: true });
    mkdirSync(join(dir('uploads'), 'tenants', 'acme'), { recursive: true });
    mkdirSync(join(dir('uploads'), 'tenants', 'acme2'), { recursive: true });
    for (const path of [join(beta, 'secret.txt'), join(dir('bucket'), 'big.txt'), join(dir('uploads'), 'shared.txt'), join(dir('uploads'), 'tenants', 'acme2', 'a.txt')]) writeFileSync(path, 'SECRET');
    for (const path of Object.values(OWN)) writeFileSync(path, 'OWN');
    symlinkSync(beta, join(incoming, 'jbeta'), 'junction');
    app = await createTestApp({
      config: {
        tenancy: { fs: { prefixed: ['uploads', 'docs'], dedicated: { uploads: { bigcorp: 'bucket' }, docs: { acme: 'vault' } } } },
        fs: { defaultProvider: 'other', providers: [...PROVIDERS, { service: 'fsTemp', name: 'fs-temp', provider: 'tmpbase' }] },
      },
      register: (container) => container.register(SilentLog).as(Log),
      resolve: [fsService],
    });
  });

  after(async () => {
    await app?.dispose();
    rmSync(join(incoming, 'jbeta'), { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const destinations: Record<string, () => fs> = {
    'the prefixed view': () => getFs('uploads'),
    "acme's view of its dedicated provider": () => getFs('docs'),
    'an unlisted provider': () => getFs('other'),
    'fs-temp': () => getFs('fs-temp'),
  };

  it("an upload into any provider whose local source lies in another tenant's files or a listed provider's shared root is refused", async () => {
    const failures: string[] = [];
    for (const [into, files] of Object.entries(destinations)) {
      for (const [from, source] of Object.entries(SECRET)) {
        // a URL is outside upload()'s type; plain JavaScript can still pass one
        const outcome = await runInTenant('acme', async () => {
          const into = files();
          await Reflect.apply(into.upload.bind(into), undefined, [source, 'stolen.txt']);
        }).then(() => 'copied', (error: unknown) => error);
        if (!(outcome instanceof InvalidArgument)) failures.push(`${from} into ${into}: ${String(outcome)}`);
        const copied = await runInTenant('acme', () => files().exists('stolen.txt'));
        if (copied) failures.push(`${from} into ${into}: the file was copied`);
      }
    }
    expect(failures).to.deep.equal([]);
  });

  it("a UNC spelling of another tenant's file is refused into every provider", async function () {
    const unc = uncSpelling();
    // Only the drive's existing administrative share is used; none is created.
    if (unc === undefined) this.skip();
    for (const [into, files] of Object.entries(destinations)) {
      await expect(runInTenant('acme', () => files().upload(unc ?? '', 'unc.txt')), into).to.be.rejectedWith(InvalidArgument);
      expect(await runInTenant('acme', () => files().exists('unc.txt')), into).to.equal(false);
    }
  });

  it("an upload from the tenant's own files or from a folder no listed provider holds works, into every provider", async () => {
    for (const [into, files] of Object.entries(destinations)) {
      for (const [from, source] of Object.entries(OWN)) {
        const name = `${from.replace(/\W+/g, '-')}.txt`;
        await runInTenant('acme', () => files().upload(source, name));
        expect(await runInTenant('acme', () => files().read(name, 'utf-8')), `${from} into ${into}`).to.equal('OWN');
      }
    }
  });

  it('the owner of a dedicated provider works with it through the listed name: copy, move, zip into fs-temp and unzip between its views', async () => {
    await runInTenant('bigcorp', async () => {
      const [up, doc] = [getFs('uploads'), getFs('docs')];
      await up.write('s.txt', 'S');
      await up.copy('s.txt', 'c.txt', doc);
      await doc.move('c.txt', 'm.txt', up);
      await zip(['s.txt'], 'big.zip', up, 'fs-temp');
      await getFs('fs-temp').unzip('big.zip', 'u', up);
      expect(await up.list('u')).to.deep.equal(['s.txt']);
    });
    expect(readFileSync(join(dir('bucket'), 'm.txt'), 'utf-8')).to.equal('S');
    expect(readFileSync(join(dir('bucket'), 'u', 's.txt'), 'utf-8')).to.equal('S');
  });

  it("other operations of an unlisted provider take provider paths: another tenant's local path is refused", async () => {
    const other = () => getFs('other');
    const operations = [() => other().copy(betaFile, 'c.txt'), () => other().zip(betaFile, other(), 'z.zip'), () => other().download(betaFile), () => other().hash(betaFile), () => other().stat(betaFile), () => other().readStream(betaFile), () => getFs('fs-temp').read(betaFile)];
    for (const operation of operations) await expect(runInTenant('acme', async () => { await operation(); })).to.be.rejectedWith(InvalidArgument);
    expect(existsSync(join(dir('other'), 'c.txt'))).to.equal(false);
    expect(readFileSync(betaFile, 'utf-8')).to.equal('SECRET');
  });
});
