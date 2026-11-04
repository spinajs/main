import { fileURLToPath } from 'node:url';
import { analyzePackage } from '@spinajs/compiler';
import { mergeFragments, readManifest } from '@spinajs/manifest';
import type { Manifest } from '@spinajs/manifest';

export const appBasicManifestPath = fileURLToPath(new URL('../../../compiler/test/fixtures/app-basic/app.manifest.json', import.meta.url));

export function appBasicManifest(): Promise<Manifest> {
  return readManifest(appBasicManifestPath);
}

const corpusRoot = fileURLToPath(new URL('../fixtures/schema-corpus', import.meta.url));

/** The schema-corpus fixture, analyzed from source: one route per schema shape the generators map. */
export async function corpusManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: `${corpusRoot}/tsconfig.json`, packageRoot: corpusRoot });
  return mergeFragments(fragment, [], { app: { name: 'schema-corpus', version: '0.1.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '' });
}
