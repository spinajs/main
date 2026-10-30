import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import glob from 'glob';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { ManifestMissing } from '@spinajs/manifest';
import type { Manifest } from '@spinajs/manifest';
import { sourceRef, testManifest } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { Controllers, FilesystemControllerSource, ManifestControllerSource } from '../src/index.js';
import { httpApp } from './common.js';

const ENV_KEYS = ['SPINAJS_MANIFEST_MODE', 'SPINAJS_MANIFEST'] as const;

// The mode is decided before any config file loads, so a test turns it on the way a deployed app does: through the environment
function manifestEnv(manifest: Manifest, mode: string, dirs: string[]): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'spinajs-manifest-'));
  dirs.push(dir);
  const file = join(dir, 'app.manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.SPINAJS_MANIFEST_MODE = mode;
  process.env.SPINAJS_MANIFEST = file;
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

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
  let restoreEnv: (() => void) | undefined;
  const tmpDirs: string[] = [];

  async function bootWith(manifest: Manifest, mode: string, resolveServices: Array<typeof Controllers> = []): Promise<TestApp> {
    restoreEnv = manifestEnv(manifest, mode, tmpDirs);
    app = await httpApp({ resolve: resolveServices });
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
    restoreEnv?.();
    restoreEnv = undefined;
    tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
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
    const booted = await bootWith(fixture.manifest, 'prefer', [Controllers]);
    const loader = await booted.resolve(Controllers);
    const names = (await loader.Controllers).map((c) => c.name);
    expect(names).to.have.length(new Set(names).size);
    expect(names).to.have.length(fixture.scanned.length);
  });
});
