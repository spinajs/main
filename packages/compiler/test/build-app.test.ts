import { expect } from 'chai';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { analyzePackage, buildAppManifest, locateFragments } from '../src/index.js';

const APP = { tsconfig: 'test/fixtures/app-basic/tsconfig.json', appRoot: 'test/fixtures/app-basic' };

describe('buildAppManifest', () => {
  before(async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
    mkdirSync('test/fixtures/pkg-basic/lib', { recursive: true });
    writeFileSync('test/fixtures/pkg-basic/lib/manifest.fragment.json', JSON.stringify(fragment));
  });

  it('locates dependency fragments through package.json#spinajs.manifest', async () => {
    const found = await locateFragments('test/fixtures/app-basic');
    expect(found.map((f) => [f.name, f.version, f.entry])).to.deep.equal([['pkg-basic', '1.0.0', 'lib/index.js']]);
    expect(found[0].fragment.replaceAll('\\', '/')).to.match(/pkg-basic\/lib\/manifest\.fragment\.json$/);
  });

  it('merges app and dependency fragments and writes the manifest', async () => {
    const { manifest, written } = await buildAppManifest({ ...APP, out: 'test/fixtures/app-basic/app.manifest.json' });
    expect(manifest.app).to.deep.include({ name: 'app-basic', version: '0.1.0', outDir: 'lib' });
    expect(manifest.packages.map((p) => [p.name, p.outDir])).to.deep.equal([['pkg-basic', 'lib']]);
    expect(manifest.controllers.map((c) => c.id)).to.deep.equal(['pkg-basic:UsersController', 'app-basic:HealthController']);
    const health = manifest.controllers.find((c) => c.id === 'app-basic:HealthController');
    expect(health?.routes[0].fullPath).to.equal('/health');
    expect(manifest.hash).to.match(/^[0-9a-f]{64}$/);
    expect((JSON.parse(readFileSync(written, 'utf8')) as { hash: string }).hash).to.equal(manifest.hash);
  });

  it('is deterministic across runs except generatedAt', async () => {
    const a = (await buildAppManifest(APP)).manifest;
    const b = (await buildAppManifest(APP)).manifest;
    expect({ ...a, generatedAt: '' }).to.deep.equal({ ...b, generatedAt: '' });
    expect(a.hash).to.equal(b.hash);
  });
});
