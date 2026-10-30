import 'mocha';
import { expect } from 'chai';
import { readManifestObject } from '@spinajs/manifest';
import { DI } from '@spinajs/di';
import { MANIFEST_TOKEN, type Manifest } from '@spinajs/manifest';
import { manifestSettingsOf } from '@spinajs/configuration';
import { createTestApp } from '../src/create-test-app.js';
import { testManifest, sourceRef, withManifest } from '../src/manifest.js';

describe('testManifest', () => {
  it('builds a manifest readManifestObject accepts', () => {
    const m = testManifest({ controllers: [{ id: 'test-app:A', className: 'A', basePath: null, policies: [], middlewares: [], routes: [], source: sourceRef('controllers/A.ts') }] });
    expect(() => readManifestObject(m)).to.not.throw();
    expect(m.manifestVersion).to.equal(2);
    expect(m.app.name).to.equal('test-app');
    expect(m.app.outDir).to.equal('test');
    expect(m.hash).to.have.length(64);
  });

  it('puts root into app.root and keeps the hash independent of it', () => {
    const a = testManifest({ root: '/a' });
    const b = testManifest({ root: '/b' });
    expect(a.app.root).to.equal('/a');
    expect(a.hash).to.equal(b.hash);
  });

  it('lets overrides replace app and sourceRef takes a package', () => {
    const m = testManifest({ app: { name: 'x', version: '1.0.0', root: '/x', outDir: 'lib' } });
    expect(m.app.name).to.equal('x');
    expect(sourceRef('a.ts', 'pkg')).to.deep.equal({ file: 'a.ts', line: 1, col: 1, package: 'pkg' });
  });
});

describe('withManifest', () => {
  const rootManifest = () => DI.RootContainer.get(MANIFEST_TOKEN, false) as Manifest | undefined;

  it('registers in the app and, for a child app, in root until disposed', async () => {
    const manifest = testManifest();
    const app = await createTestApp({ scope: 'child', register: withManifest(manifest, 'require') });
    expect(app.container.get(MANIFEST_TOKEN, false)).to.equal(manifest);
    expect(manifestSettingsOf(app.container)?.mode).to.equal('require');
    expect(rootManifest()).to.equal(manifest);
    await app.dispose();
    expect(rootManifest()).to.equal(undefined);
    expect(manifestSettingsOf(DI.RootContainer)).to.equal(undefined);
  });

  it('leaves no manifest behind after a root app is disposed', async () => {
    const app = await createTestApp({ register: withManifest(testManifest()) });
    expect(rootManifest()).to.not.equal(undefined);
    await app.dispose();
    expect(rootManifest()).to.equal(undefined);
  });

  it('removes from root only what it added', async () => {
    const before = testManifest({ root: '/before' });
    DI.RootContainer.register(before).asValue(MANIFEST_TOKEN);
    try {
      const app = await createTestApp({ scope: 'child', register: withManifest(testManifest()) });
      await app.dispose();
      expect(rootManifest()).to.equal(before);
    } finally {
      DI.RootContainer.uncache(MANIFEST_TOKEN);
    }
  });

  it('keeps the root registration of a child app that is still live', async () => {
    const shared = testManifest();
    const other = testManifest({ root: '/other' });
    const first = await createTestApp({ scope: 'child', register: withManifest(shared) });
    const second = await createTestApp({ scope: 'child', register: withManifest(shared) });
    const third = await createTestApp({ scope: 'child', register: withManifest(other) });
    await third.dispose();
    await first.dispose();
    expect(rootManifest()).to.equal(shared);
    await second.dispose();
    expect(rootManifest()).to.equal(undefined);
  });
});
