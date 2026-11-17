import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashManifest, mergeFragments, readFragment, type Manifest } from '@spinajs/manifest';
import { analyzePackage } from './analyze-package.js';
import type { AppDirs } from './extractors/effective-dirs.js';
import { locateFragments } from './fragments.js';
import { globalRouteMiddlewaresOf } from './extractors/policies.js';

// `src/` under ts-node and `lib/` once built both sit one level below the package root.
const COMPILER_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** The app's compiled policy as the build command read it from `authz.ir.json`: its canonical text and SHA-256, or why the file cannot be used. */
export type ManifestPolicy = { ir: string; policyHash: string } | { problem: string };

/** `NoAppDirs` from `requireAppDirs` is thrown before anything is written. */
export interface BuildAppOptions extends Partial<AppDirs> {
  tsconfig: string;
  appRoot: string;
  /** Defaults to `<appRoot>/app.manifest.json`. */
  out?: string;
  schemaDerivation?: boolean;
  /** `APP_ENV` of the configuration `effectiveDirs` came from. */
  buildEnv?: string;
  /** `http.routes.middlewares` of that configuration, as it holds it. */
  globalRouteMiddlewares?: unknown;
  /** From `authz.ir.json` (`spinajs authz:compile`). The caller canonicalizes it: the compiler does not depend on the IR package. */
  policy?: ManifestPolicy;
}

export async function buildAppManifest(options: BuildAppOptions): Promise<{ manifest: Manifest; written: string }> {
  const root = resolve(options.appRoot);
  const app = await analyzePackage({ tsconfig: options.tsconfig, packageRoot: root, schemaDerivation: options.schemaDerivation, effectiveDirs: options.effectiveDirs, defaultDirs: options.defaultDirs, requireAppDirs: options.requireAppDirs, runAppRoot: options.runAppRoot });
  const locations = await locateFragments(root);
  const fragments = await Promise.all(locations.map((l) => readFragment(l.fragment)));

  const merged = mergeFragments(app, fragments, {
    app: { name: app.package.name, version: app.package.version, root, outDir: app.package.outDir },
    packages: locations.map((l, i) => {
      const { outDir, configFiles } = fragments[i].package;
      return { name: l.name, version: l.version, entry: l.entry, outDir, fragment: l.fragmentRel, ...(configFiles ? { configFiles } : {}) };
    }),
    generatedAt: new Date().toISOString(),
    buildEnv: options.buildEnv,
    globalRouteMiddlewares: globalRouteMiddlewaresOf(options.globalRouteMiddlewares),
    schemaDerivation: options.schemaDerivation === false ? false : undefined,
    compilerVersion: COMPILER_VERSION,
  });
  if (merged.authz) {
    const policy = options.policy;
    if (policy === undefined) merged.diagnostics.push({ code: 'AUTHZ010', severity: 'info', message: 'policy IR not in manifest: run `spinajs authz:compile` and commit authz.ir.json' });
    else if ('problem' in policy) merged.diagnostics.push({ code: 'AUTHZ011', severity: 'warning', message: `authz.ir.json is not in the manifest: ${policy.problem}` });
    else merged.authz = { ...merged.authz, ir: policy.ir, policyHash: policy.policyHash };
  }
  const manifest: Manifest = { ...merged, hash: hashManifest(merged) };

  const written = resolve(options.out ?? join(root, 'app.manifest.json'));
  writeFileSync(written, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, written };
}
