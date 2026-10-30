import { fileURLToPath } from 'node:url';
import { readManifest } from '@spinajs/manifest';
import type { Manifest } from '@spinajs/manifest';

const manifestPath = fileURLToPath(new URL('../../../compiler/test/fixtures/app-basic/app.manifest.json', import.meta.url));

export function appBasicManifest(): Promise<Manifest> {
  return readManifest(manifestPath);
}
