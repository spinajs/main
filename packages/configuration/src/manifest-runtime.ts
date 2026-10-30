import { existsSync } from 'node:fs';
import { join, normalize, relative, resolve, sep } from 'node:path';
import glob from 'glob';
import minimatch from 'minimatch';
import { token } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { manifestFileFor, MANIFEST_TOKEN, type Manifest } from '@spinajs/manifest';

/** Typed key of the runtime manifest; same string key as MANIFEST_TOKEN. */
export const MANIFEST = token<Manifest>(MANIFEST_TOKEN, 'runtime manifest');

export function registerManifest(container: IContainer, manifest: Manifest): void {
  container.register(manifest).asValue(MANIFEST.key, true);
}

/** The manifest of the nearest container in the lineage that registered one. */
export function manifestOf(container: IContainer): Manifest | undefined {
  let current: IContainer | undefined = container;
  while (current) {
    const found = current.get(MANIFEST, false);
    if (found) return found;
    current = current.Parent;
  }
  return undefined;
}

/** The app's own config dirs, in merge order; package config files merge between the two lists. */
export interface ProjectConfigDirs {
  beforePackages: string[];
  afterPackages: string[];
}

export function projectConfigDirs(cwd: string, runApp?: string, appBaseDir?: string, customPaths?: string[]): ProjectConfigDirs {
  const root = resolve(cwd);
  const afterPackages = ['lib/config', 'dist/config', 'build/config', 'config'].map((d) => normalize(join(root, d)));

  if (runApp) {
    if (appBaseDir) {
      afterPackages.push(join(appBaseDir, `/${runApp}/config`));
    }
    for (const prefix of ['', '/dist', '/lib', '/build']) {
      afterPackages.push(join(cwd, `${prefix}/apps/${runApp}/config`));
    }
  }

  if (customPaths) {
    afterPackages.push(...customPaths);
  }

  return { beforePackages: [normalize(join(root, 'src', '/config'))], afterPackages };
}

/** Without a manifest only this scope is globbed ( `node_modules/@spinajs/*` ), so only it is loaded with one. */
const PACKAGE_SCOPE = '@spinajs/';

interface ListedConfigFile {
  // `<package>/<outDir>/config/...`: sorting by it gives the order the glob over node_modules/@spinajs gives
  order: string;
  file: string;
}

/**
 * Config files of the manifest packages that match `pattern` ( a file-source pattern such as `!(*.*).{cjs,js}` ),
 * in the order the `node_modules/@spinajs/*\/lib/config/**` glob lists them. Every file goes through
 * `manifestFileFor`, which keeps it inside its package root.
 */
export function manifestPackageConfigFiles(manifest: Manifest, pattern: string, cwd: string): string[] {
  const listed: ListedConfigFile[] = [];

  for (const pkg of manifest.packages) {
    if (!pkg.name.startsWith(PACKAGE_SCOPE)) continue;

    const resolveFile = (file: string) => manifestFileFor({ source: { file: `${pkg.outDir}/${file}`, line: 1, col: 1, package: pkg.name } }, manifest, cwd);
    const files = pkg.configFiles ?? builtConfigFiles(resolveFile('config'), pattern);

    for (const file of files) {
      if (!file.startsWith('config/') || !minimatch(file.slice('config/'.length), `**/${pattern}`)) continue;
      const resolved = resolveFile(file);
      if (existsSync(resolved)) {
        listed.push({ order: `${pkg.name}/${pkg.outDir}/${file}`, file: resolved });
      }
    }
  }

  // glob sorts its results with localeCompare( 'en' )
  return listed.sort((a, b) => a.order.localeCompare(b.order, 'en')).map((l) => l.file);
}

// A fragment older than `configFiles`: its one config dir is globbed, as without a manifest.
function builtConfigFiles(configDir: string, pattern: string): string[] {
  return glob.sync(`**/${pattern}`, { cwd: configDir }).map((f) => `config/${relative(configDir, join(configDir, f)).split(sep).join('/')}`);
}
