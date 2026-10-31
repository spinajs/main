import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashManifest, mergeFragments, readFragment, type Manifest } from '@spinajs/manifest';
import { analyzePackage } from './analyze-package.js';
import type { AppDirs } from './extractors/effective-dirs.js';
import { locateFragments } from './fragments.js';

/** `NoAppDirs` from `requireAppDirs` is thrown before anything is written. */
export interface BuildAppOptions extends Partial<AppDirs> {
  tsconfig: string;
  appRoot: string;
  /** Defaults to `<appRoot>/app.manifest.json`. */
  out?: string;
  schemaDerivation?: boolean;
}

export async function buildAppManifest(options: BuildAppOptions): Promise<{ manifest: Manifest; written: string }> {
  const root = resolve(options.appRoot);
  const app = await analyzePackage({ tsconfig: options.tsconfig, packageRoot: root, schemaDerivation: options.schemaDerivation, effectiveDirs: options.effectiveDirs, defaultDirs: options.defaultDirs, requireAppDirs: options.requireAppDirs });
  const locations = await locateFragments(root);
  const fragments = await Promise.all(locations.map((l) => readFragment(l.fragment)));

  const merged = mergeFragments(app, fragments, {
    app: { name: app.package.name, version: app.package.version, root, outDir: app.package.outDir },
    packages: locations.map((l, i) => {
      const { outDir, configFiles } = fragments[i].package;
      return { name: l.name, version: l.version, entry: l.entry, outDir, fragment: l.fragmentRel, ...(configFiles ? { configFiles } : {}) };
    }),
    generatedAt: new Date().toISOString(),
  });
  const manifest: Manifest = { ...merged, hash: hashManifest(merged) };

  const written = resolve(options.out ?? join(root, 'app.manifest.json'));
  writeFileSync(written, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, written };
}
