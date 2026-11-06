import 'mocha';
import { expect } from 'chai';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diffManifest, hashManifest, mergeFragments, type Manifest } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';

const TMP = resolve('test/fixtures/.tmp-inherited-diff');

async function build(root: string): Promise<Manifest> {
  const app = await analyzePackage({ tsconfig: join(root, 'tsconfig.json'), packageRoot: root });
  const merged = mergeFragments(app, [], { app: { name: 'app-basic', version: '0.1.0', root: '.', outDir: app.package.outDir }, packages: [], generatedAt: '2026-01-01T00:00:00.000Z' });
  return { ...merged, hash: hashManifest(merged) };
}

describe('manifest:diff of a change in an inherited route', function () {
  this.timeout(300_000);
  let baseline: Manifest;
  let changed: Manifest;

  before(async () => {
    rmSync(TMP, { recursive: true, force: true });
    cpSync(resolve('test/fixtures/app-basic'), TMP, { recursive: true });
    baseline = await build(TMP);
    const file = join(TMP, 'src/controllers/articles.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('export type CreateArticleDto = { title: string };', 'export type CreateArticleDto = { title: string; slug: string };'));
    changed = await build(TMP);
  });

  after(() => rmSync(TMP, { recursive: true, force: true }));

  it('reports the body change on the subclass path as breaking', () => {
    const change = diffManifest(baseline, changed).changes.find((c) => c.section === 'routes' && c.id === 'POST /articles/add');
    expect(change).to.deep.include({ kind: 'changed', breaking: true });
    expect(change?.detail).to.include('slug');
  });

  it('reports nothing else in routes', () => {
    expect(diffManifest(baseline, changed).changes.filter((c) => c.section === 'routes').map((c) => c.id)).to.deep.equal(['POST /articles/add']);
  });
});
