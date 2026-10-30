import 'mocha';
import { expect } from 'chai';
import { readManifestObject } from '@spinajs/manifest';
import { DI } from '@spinajs/di';
import { MANIFEST_TOKEN } from '@spinajs/manifest';
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
  it('registers in the app and, for a child app, in root until disposed', async () => {
    const manifest = testManifest();
    const app = await createTestApp({ scope: 'child', register: withManifest(manifest) });
    expect(app.container.get(MANIFEST_TOKEN, false)).to.equal(manifest);
    expect(DI.RootContainer.get(MANIFEST_TOKEN, false)).to.equal(manifest);
    await app.dispose();
    expect(DI.RootContainer.get(MANIFEST_TOKEN, false)).to.equal(undefined);
  });

  it('leaves no manifest behind after a root app is disposed', async () => {
    const app = await createTestApp({ register: withManifest(testManifest()) });
    expect(DI.RootContainer.get(MANIFEST_TOKEN, false)).to.not.equal(undefined);
    await app.dispose();
    expect(DI.RootContainer.get(MANIFEST_TOKEN, false)).to.equal(undefined);
  });
});
