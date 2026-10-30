import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import glob from 'glob';
import { join, resolve } from 'node:path';
import { createTestApp, disposeTestApps, testManifest, sourceRef, withManifest } from '@spinajs/testing';
import { ManifestMissing } from '@spinajs/manifest';
import { ListFromFiles, ResolveFromFiles } from '../src/index.js';
import { FooService } from './test-services/singletons/FooService.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const root = process.cwd();
const singletons = join(root, 'test', 'test-services', 'singletons');

type Listed = Array<{ file: string; name: string; type: unknown; instance: unknown }>;

// The decorator caches its result per class, so every test gets a class of its own.
function listerOf(options: { manifest: 'commands' } | undefined = { manifest: 'commands' }) {
  class Lister {
    @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.singletons', undefined, options)
    public Items!: Promise<Listed>;
  }
  return Lister;
}

function resolverOf() {
  class Resolver {
    @ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.singletons', undefined, { manifest: 'commands' })
    public Items!: Promise<Listed>;
  }
  return Resolver;
}

const manifest = testManifest({
  root,
  commands: [{ name: 'foo', className: 'FooService', options: [], arguments: [], source: sourceRef('test/test-services/singletons/FooService.ts') }],
});

const config = (mode: string) => ({ system: { manifest: { mode }, dirs: { singletons: [singletons] } } });

describe('ListFromFiles manifest fast path', () => {
  afterEach(async () => {
    sinon.restore();
    await disposeTestApps();
  });

  it('lists manifest entries without globbing in prefer mode', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const app = await createTestApp({ config: config('prefer'), register: withManifest(manifest) });
    const items = await app.container.resolve(listerOf()).Items;
    expect(items.map((i) => i.name)).to.deep.equal(['FooService']);
    expect(items[0].type).to.equal(FooService);
    expect(items[0].file).to.equal(resolve(singletons, 'FooService.js'));
    expect(globSync.called).to.equal(false);
    await app.dispose();
  });

  it('resolves instances for ResolveFromFiles', async () => {
    const app = await createTestApp({ config: config('prefer'), register: withManifest(manifest) });
    const items = await app.container.resolve(resolverOf()).Items;
    expect(items[0].instance).to.be.instanceOf(FooService);
    await app.dispose();
  });

  it('scans when mode is off', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const app = await createTestApp({ config: config('off'), register: withManifest(manifest) });
    await app.container.resolve(listerOf()).Items;
    expect(globSync.called).to.equal(true);
    await app.dispose();
  });

  it('prefer mode without a manifest scans', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const app = await createTestApp({ config: config('prefer') });
    await app.container.resolve(listerOf()).Items;
    expect(globSync.called).to.equal(true);
    await app.dispose();
  });

  it('require mode without a manifest throws ManifestMissing', async () => {
    const app = await createTestApp({ config: { system: { manifest: { mode: 'require' }, dirs: { singletons: [] } } } });
    await expect(app.container.resolve(listerOf()).Items).to.be.rejectedWith(ManifestMissing, /commands/);
    await app.dispose();
  });

  it('fails when a listed class is not exported by its file', async () => {
    const bad = testManifest({
      root,
      commands: [{ name: 'x', className: 'Nope', options: [], arguments: [], source: sourceRef('test/test-services/singletons/FooService.ts') }],
    });
    const app = await createTestApp({ config: config('require'), register: withManifest(bad) });
    await expect(app.container.resolve(listerOf()).Items).to.be.rejectedWith(ManifestMissing, /does not export class Nope/);
    await app.dispose();
  });

  it('refuses an entry whose source leaves the package root', async () => {
    const escaping = testManifest({
      root,
      commands: [{ name: 'x', className: 'FooService', options: [], arguments: [], source: sourceRef('../../outside/FooService.ts') }],
    });
    const app = await createTestApp({ config: config('require'), register: withManifest(escaping) });
    await expect(app.container.resolve(listerOf()).Items).to.be.rejectedWith(ManifestMissing, /leaves the root/);
    await app.dispose();
  });
});
