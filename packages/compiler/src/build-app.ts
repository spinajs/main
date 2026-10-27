import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashManifest, mergeFragments, readFragment, type Manifest } from '@spinajs/manifest';
import { analyzePackage } from './analyze-package.js';
import { locateFragments } from './fragments.js';

export interface BuildAppOptions {
  tsconfig: string;
  appRoot: string;
  /** Defaults to `<appRoot>/app.manifest.json`. */
  out?: string;
  schemaDerivation?: boolean;
  /** Merge manifest fragments of dependencies. Defaults to true. */
  dependencies?: boolean;
}

export async function buildAppManifest(options: BuildAppOptions): Promise<{ manifest: Manifest; written: string }> {
  const root = resolve(options.appRoot);
  const app = await analyzePackage({ tsconfig: options.tsconfig, packageRoot: root, schemaDerivation: options.schemaDerivation });
  const locations = options.dependencies === false ? [] : await locateFragments(root);
  const fragments = await Promise.all(locations.map((l) => readFragment(l.fragment)));

  const merged = mergeFragments(app, fragments, {
    app: { name: app.package.name, version: app.package.version, root, outDir: app.package.outDir },
    packages: locations.map((l, i) => ({ name: l.name, version: l.version, entry: l.entry, outDir: fragments[i].package.outDir, fragment: l.fragmentRel })),
    generatedAt: new Date().toISOString(),
  });
  const manifest: Manifest = { ...merged, hash: hashManifest(merged) };

  const written = resolve(options.out ?? join(root, 'app.manifest.json'));
  writeFileSync(written, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, written };
}
