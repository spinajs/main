import { expect } from 'chai';
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzePackage, buildAppManifest, locateFragments } from '../src/index.js';

const OUT_DIR = 'test/fixtures/.tmp-out';
// Built @spinajs/* dependencies carry fragments too; these tests pin only the fixture packages.
const own = <T extends { id: string }>(items: T[]): T[] => items.filter((i) => /^(app|pkg)-basic:/.test(i.id));
const ownPackage = <T extends { name: string }>(items: T[]): T[] => items.filter((i) => i.name === 'pkg-basic');
const APP = { tsconfig: 'test/fixtures/app-basic/tsconfig.json', appRoot: 'test/fixtures/app-basic', out: `${OUT_DIR}/app.manifest.json` };

describe('buildAppManifest', () => {
  before(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
    mkdirSync('test/fixtures/pkg-basic/lib', { recursive: true });
    writeFileSync('test/fixtures/pkg-basic/lib/manifest.fragment.json', JSON.stringify(fragment));
  });

  after(() => {
    rmSync(OUT_DIR, { recursive: true, force: true });
  });

  it('locates dependency fragments through package.json#spinajs.manifest', async () => {
    const found = ownPackage(await locateFragments('test/fixtures/app-basic'));
    expect(found.map((f) => [f.name, f.version, f.entry])).to.deep.equal([['pkg-basic', '1.0.0', 'lib/index.js']]);
    expect(found[0].fragment.replaceAll('\\', '/')).to.match(/pkg-basic\/lib\/manifest\.fragment\.json$/);
  });

  it('merges app and dependency fragments and writes the manifest', async () => {
    const { manifest, written } = await buildAppManifest(APP);
    expect(manifest.app).to.deep.include({ name: 'app-basic', version: '0.1.0', outDir: 'lib' });
    expect(ownPackage(manifest.packages).map((p) => [p.name, p.outDir])).to.deep.equal([['pkg-basic', 'lib']]);
    expect(own(manifest.controllers).map((c) => c.id)).to.deep.equal(['pkg-basic:UsersController', 'app-basic:HealthController', 'app-basic:UsersController']);
    const health = manifest.controllers.find((c) => c.id === 'app-basic:HealthController');
    expect(health?.routes[0].fullPath).to.equal('/health');
    expect(ownPackage(manifest.packages)[0].fragment).to.equal('node_modules/pkg-basic/lib/manifest.fragment.json');
    expect(manifest.hash).to.match(/^[0-9a-f]{64}$/);
    expect((JSON.parse(readFileSync(written, 'utf8')) as { hash: string }).hash).to.equal(manifest.hash);
  });

  it('merges real @spinajs/* dependency fragments under logical node_modules paths', async function () {
    const located = (await locateFragments('test/fixtures/app-basic')).filter((f) => f.name.startsWith('@spinajs/'));
    if (located.length === 0) this.skip(); // dependencies not built in this checkout
    const { manifest } = await buildAppManifest(APP);
    const merged = manifest.packages.filter((p) => p.name.startsWith('@spinajs/'));
    expect(merged.map((p) => p.name).sort()).to.deep.equal(located.map((f) => f.name).sort());
    for (const p of merged) expect(p.fragment).to.equal(`node_modules/${p.name}/lib/manifest.fragment.json`);
  });

  it('every body and query param and every non-void response has a schema in the manifest', async () => {
    const { manifest } = await buildAppManifest(APP);
    const routes = own(manifest.controllers).flatMap((controller) => controller.routes);
    expect(routes.length).to.be.greaterThan(0);
    for (const route of routes) {
      for (const param of route.params.filter((p) => p.kind === 'FromBody' || p.kind === 'FromQuery')) {
        const id = param.runtimeType.schema;
        expect(id, `${route.handler}:${param.name}`).to.be.a('string');
        expect(manifest.schemas).to.have.property(id!);
      }
      if (!['void', 'Ok', 'Json', 'Created'].includes(route.returnType.text)) {
        expect(route.returnType.schema, route.handler).to.be.a('string');
        expect(manifest.schemas).to.have.property(route.returnType.schema!);
      }
    }
  });

  it('omits the app schemas when derivation is off', async () => {
    const { manifest } = await buildAppManifest({ ...APP, schemaDerivation: false });
    const typeRefs = manifest.controllers.filter((c) => c.id.startsWith('app-basic:')).flatMap((c) => c.routes.map((r) => r.returnType));
    expect(typeRefs).to.not.be.empty;
    expect(typeRefs.every((t) => t.schema === undefined)).to.be.true;
  });

  it('is deterministic across runs except generatedAt', async () => {
    const a = (await buildAppManifest(APP)).manifest;
    const b = (await buildAppManifest(APP)).manifest;
    expect({ ...a, generatedAt: '' }).to.deep.equal({ ...b, generatedAt: '' });
    expect(a.hash).to.equal(b.hash);
  });

  it('hashes identically for copies of the app in different directories', async () => {
    const dirs = ['test/fixtures/.tmp-a/app-basic', 'test/fixtures/.tmp-b/app-basic'];
    const hashes: string[] = [];
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(resolve(dir, 'node_modules'), { recursive: true });
      for (const f of ['src', 'package.json', 'tsconfig.json']) cpSync(`test/fixtures/app-basic/${f}`, `${dir}/${f}`, { recursive: true });
      symlinkSync(resolve('test/fixtures/pkg-basic'), resolve(dir, 'node_modules/pkg-basic'), 'junction');
      const { manifest } = await buildAppManifest({ tsconfig: `${dir}/tsconfig.json`, appRoot: dir, out: `${dir}/app.manifest.json` });
      expect(ownPackage(manifest.packages)[0].fragment).to.equal('node_modules/pkg-basic/lib/manifest.fragment.json');
      hashes.push(manifest.hash);
    }
    rmSync('test/fixtures/.tmp-a', { recursive: true, force: true });
    rmSync('test/fixtures/.tmp-b', { recursive: true, force: true });
    expect(hashes[0]).to.equal(hashes[1]);
  });
});
