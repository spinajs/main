import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import glob from 'glob';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { ManifestMissing } from '@spinajs/manifest';
import type { Manifest, ManifestMode } from '@spinajs/manifest';
import { sourceRef, testManifest, withManifest } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { DefaultControllerCache } from '../src/cache.js';
import { Controllers, FilesystemControllerSource, ManifestControllerSource } from '../src/index.js';
import { httpApp } from './common.js';

const sameFile = (file: string): string => join(dirname(file), basename(file).replace(/\.[mc]?[jt]s$/, ''));

// the controllers the directory scan finds, written out as the manifest the compiler would emit for this app
async function scannedManifest(): Promise<{ manifest: Manifest; scanned: Array<{ name: string; file: string }> }> {
  const app = await httpApp();
  try {
    const source = await app.resolve(FilesystemControllerSource);
    const scanned = (await source.getControllers()).map((c) => ({ name: c.name, file: c.file }));
    const controllers = scanned.map((c) => ({
      id: `test-app:${c.name}`,
      className: c.name,
      basePath: '',
      policies: [],
      middlewares: [],
      routes: [],
      source: sourceRef(relative(process.cwd(), c.file).split(sep).join('/')),
    }));
    return { manifest: testManifest({ root: process.cwd(), controllers }), scanned };
  } finally {
    await app.dispose();
  }
}

describe('ManifestControllerSource', function () {
  this.timeout(60000);

  let app: TestApp | undefined;
  let fixture: Awaited<ReturnType<typeof scannedManifest>>;

  async function bootWith(manifest: Manifest, mode: ManifestMode, resolveServices: Array<typeof Controllers> = []): Promise<TestApp> {
    app = await httpApp({ register: withManifest(manifest, mode), resolve: resolveServices });
    return app;
  }

  before(async () => {
    // also fills the memoized directory scan, which later cases must not depend on in require mode
    fixture = await scannedManifest();
  });

  afterEach(async () => {
    sinon.restore();
    await app?.dispose();
    app = undefined;
  });

  it('the fixture scan finds controllers', () => {
    expect(fixture.scanned.length).to.be.greaterThan(0);
  });

  it('lists the manifest controllers and does not scan in require mode', async () => {
    const booted = await bootWith(fixture.manifest, 'require');
    const globSync = sinon.spy(glob, 'sync');

    const listed = await (await booted.resolve(ManifestControllerSource)).getControllers();
    expect(listed.length).to.equal(fixture.scanned.length);
    expect(await (await booted.resolve(FilesystemControllerSource)).getControllers()).to.deep.equal([]);
    expect(globSync.called).to.equal(false);
  });

  it('parity: manifest mode lists exactly the controllers the scan finds, in the same order', async () => {
    const booted = await bootWith(fixture.manifest, 'require');
    const listed = (await (await booted.resolve(ManifestControllerSource)).getControllers()).map((c) => ({ name: c.name, file: sameFile(c.file) }));
    expect(listed).to.deep.equal(fixture.scanned.map((c) => ({ name: c.name, file: sameFile(resolve(c.file)) })));
  });

  it('lists controllers in the order the directory scan finds them, whatever order the manifest has', async () => {
    const fixtures = resolve(process.cwd(), 'test', 'controllers-order');
    const scanOrder = glob.sync(join(fixtures, '/**/!(*.d).{ts,js}').replace(/\\/g, '/')).map((f) => basename(f).replace(/\.[mc]?[jt]s$/, ''));
    // the compiler sorts by code unit: Beta, Zeta, alpha, gamma
    const compilerOrder = [...scanOrder].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(compilerOrder).to.not.deep.equal(scanOrder);

    const manifest = testManifest({
      root: process.cwd(),
      controllers: compilerOrder.map((name) => ({
        id: `test-app:${name}`,
        className: name,
        basePath: '',
        policies: [],
        middlewares: [],
        routes: [],
        source: sourceRef(`test/controllers-order/${name}.ts`),
      })),
    });
    const booted = await bootWith(manifest, 'require');

    const listed = await (await booted.resolve(ManifestControllerSource)).getControllers();
    expect(listed.map((c) => c.name)).to.deep.equal(scanOrder);
  });

  it('is empty in off mode and the filesystem source still scans', async () => {
    const booted = await bootWith(fixture.manifest, 'off');

    expect(await (await booted.resolve(ManifestControllerSource)).getControllers()).to.deep.equal([]);
    expect((await (await booted.resolve(FilesystemControllerSource)).getControllers()).length).to.equal(fixture.scanned.length);
  });

  it('is empty when no manifest is registered', async () => {
    const booted = await httpApp();
    app = booted;
    expect(await (await booted.resolve(ManifestControllerSource)).getControllers()).to.deep.equal([]);
  });

  it('skips controllers of a listed package that is not installed', async () => {
    const [first] = fixture.manifest.controllers;
    const ghost = { ...first, id: 'ghost:Ghost', className: 'Ghost', source: sourceRef('src/Ghost.ts', '@ghost/not-installed') };
    const manifest = testManifest({
      root: process.cwd(),
      controllers: [first, ghost],
      packages: [{ name: '@ghost/not-installed', version: '1.0.0', entry: 'lib/index.js', outDir: 'lib', fragment: 'lib/manifest.fragment.json' }],
    });
    const booted = await bootWith(manifest, 'prefer');

    const listed = await (await booted.resolve(ManifestControllerSource)).getControllers();
    expect(listed.map((c) => c.name)).to.deep.equal([first.className]);
  });

  it('fails when a listed class is not exported by its file', async () => {
    const missing = testManifest({ root: process.cwd(), controllers: [{ ...fixture.manifest.controllers[0], className: 'NotExported' }] });
    const booted = await bootWith(missing, 'require');

    let error: unknown;
    try {
      await (await booted.resolve(ManifestControllerSource)).getControllers();
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(ManifestMissing);
  });

  it('the loader merges both sources without duplicating a controller in prefer mode', async () => {
    // the scan lists manifest files too, and a ts-node fixture has no compiled .d.ts for the cache to parse
    sinon.stub(DefaultControllerCache.prototype, 'getCache').resolves({});
    const booted = await bootWith(fixture.manifest, 'prefer', [Controllers]);
    const loader = await booted.resolve(Controllers);
    const names = (await loader.Controllers).map((c) => c.name);
    expect(names).to.have.length(new Set(names).size);
    expect(names).to.have.length(fixture.scanned.length);
  });
});
