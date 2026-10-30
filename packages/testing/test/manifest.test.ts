import 'mocha';
import { expect } from 'chai';
import { readManifestObject } from '@spinajs/manifest';
import { testManifest, sourceRef } from '../src/manifest.js';

describe('testManifest', () => {
  it('builds a manifest readManifestObject accepts', () => {
    const m = testManifest({ controllers: [{ id: 'test-app:A', className: 'A', basePath: null, policies: [], middlewares: [], routes: [], source: sourceRef('controllers/A.ts') }] });
    expect(() => readManifestObject(m)).to.not.throw();
    expect(m.manifestVersion).to.equal(1);
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
