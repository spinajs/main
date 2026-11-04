import { fileURLToPath } from 'node:url';
import { analyzePackage } from '@spinajs/compiler';
import { mergeFragments, type Manifest } from '@spinajs/manifest';

const pagedApp = fileURLToPath(new URL('../fixtures/paged-app', import.meta.url));

/** The manifest of `test/fixtures/paged-app`, whose controllers serve real pages (unlike the compiler's paged-app). */
export async function pagedManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: `${pagedApp}/tsconfig.json`, packageRoot: pagedApp });
  return mergeFragments(fragment, [], { app: { name: 'paged-app', version: '0.1.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '' });
}
