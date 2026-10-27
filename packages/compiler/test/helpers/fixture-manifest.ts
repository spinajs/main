import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Manifest } from '@spinajs/manifest';
import { buildAppManifest } from '../../src/index.js';

export const APP_BASIC_MANIFEST = resolve('test/fixtures/app-basic/app.manifest.json');

/**
 * Builds the generator fixture manifest. Dependencies are left out on purpose: pkg-basic declares its own
 * UsersController and UserCreated, which would clash with the app ones in generator snapshots.
 * `app.root` is made relative so the committed file does not depend on the checkout location.
 */
export async function buildFixtureManifest(): Promise<Manifest> {
  const dir = mkdtempSync(join(tmpdir(), 'app-basic-manifest-'));
  try {
    const { manifest } = await buildAppManifest({
      tsconfig: 'test/fixtures/app-basic/tsconfig.json',
      appRoot: 'test/fixtures/app-basic',
      dependencies: false,
      out: join(dir, 'app.manifest.json'),
    });
    return { ...manifest, app: { ...manifest.app, root: '.' } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Regenerate with `UPDATE_FIXTURE_MANIFEST=1 npx ts-mocha -p tsconfig.json test/fixture-manifest.test.ts`. */
export async function writeFixtureManifest(): Promise<void> {
  writeFileSync(APP_BASIC_MANIFEST, JSON.stringify(await buildFixtureManifest(), null, 2) + '\n');
}
