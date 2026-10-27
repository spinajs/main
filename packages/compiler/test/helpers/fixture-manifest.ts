import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashManifest, mergeFragments, type Manifest } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';

export const APP_BASIC_MANIFEST = resolve('test/fixtures/app-basic/app.manifest.json');

/**
 * Builds the generator fixture manifest from app-basic alone: pkg-basic declares its own UsersController
 * and UserCreated, which would clash with the app ones in generator snapshots. `app.root` is relative
 * so the committed file does not depend on the checkout location.
 */
export async function buildFixtureManifest(): Promise<Manifest> {
  const app = await analyzePackage({ tsconfig: 'test/fixtures/app-basic/tsconfig.json', packageRoot: 'test/fixtures/app-basic' });
  const pkg = JSON.parse(readFileSync('test/fixtures/app-basic/package.json', 'utf8')) as { name: string; version: string };
  const merged = mergeFragments(app, [], {
    app: { name: pkg.name, version: pkg.version, root: '.', outDir: app.package.outDir },
    packages: [],
    generatedAt: new Date().toISOString(),
  });
  return { ...merged, hash: hashManifest(merged) };
}

/** Regenerate with `UPDATE_FIXTURE_MANIFEST=1 npx ts-mocha -p tsconfig.json test/fixture-manifest.test.ts`. */
export async function writeFixtureManifest(): Promise<void> {
  writeFileSync(APP_BASIC_MANIFEST, JSON.stringify(await buildFixtureManifest(), null, 2) + '\n');
}
