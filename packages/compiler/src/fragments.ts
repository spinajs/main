import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

export interface FragmentLocation {
  name: string;
  version: string;
  entry: string;
  /** Absolute path to the dependency's manifest fragment. */
  fragment: string;
  /** Relative to the app root, forward slashes; the logical `node_modules/<name>/...` path when installed under the app, so layout (workspace, npm, pnpm) does not leak into the hash. */
  fragmentRel: string;
}

interface PackageJson {
  name: string;
  version: string;
  main?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  spinajs?: { manifest?: string };
}

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

/** Hoisted installs (npm workspaces) put dependencies in an ancestor node_modules; a package restricting `exports` hides its package.json from `require.resolve`, so walk up directly. */
function hoistedPackageJson(root: string, name: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

function resolvedPackageJson(name: string, require: NodeRequire): string | undefined {
  try {
    return require.resolve(`${name}/package.json`);
  } catch {
    return undefined;
  }
}

function dependencyNames(pkg: PackageJson): string[] {
  return [...new Set([pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies].flatMap((deps) => Object.keys(deps ?? {})))].sort();
}

function installedPackageJson(fromDir: string, name: string): string | undefined {
  return hoistedPackageJson(fromDir, name) ?? resolvedPackageJson(name, createRequire(join(fromDir, 'package.json')));
}

/**
 * Names of every installed package reachable from the app through `dependencies`, `optionalDependencies` and
 * `peerDependencies`. Each dependency resolves from its dependent's real directory, as node resolves it, so a
 * copy nested under its dependent is followed too. Packages without a fragment are walked through: they can still
 * depend on one that has a fragment.
 */
function dependencyClosure(root: string, appName: string): string[] {
  const names = new Set<string>();
  const visited = new Set<string>([realpathSync(root)]);
  const queue = [root];

  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    for (const name of dependencyNames(readPackageJson(join(dir, 'package.json')))) {
      const pkgPath = installedPackageJson(dir, name);
      if (!pkgPath || name === appName) continue;
      names.add(name);
      const real = realpathSync(dirname(pkgPath));
      if (!visited.has(real)) {
        visited.add(real);
        queue.push(real);
      }
    }
  }
  return [...names].sort();
}

/**
 * Fragment of a package as the app root resolves it: the copy the runtime (`packageRootOf`) and the config walk use.
 * A name installed only under another package does not resolve here and is left out.
 */
function locateFragment(root: string, name: string, require: NodeRequire): FragmentLocation | undefined {
  const hoisted = hoistedPackageJson(root, name);
  const depPkgPath = hoisted ?? resolvedPackageJson(name, require);
  if (!depPkgPath) return undefined;
  const dep = readPackageJson(depPkgPath);
  if (!dep.spinajs?.manifest) return undefined;
  const fragment = join(dirname(depPkgPath), dep.spinajs.manifest);
  if (!existsSync(fragment)) return undefined;
  const installed = hoisted !== undefined || existsSync(join(root, 'node_modules', name));
  const fragmentRel = installed ? `node_modules/${name}/${dep.spinajs.manifest.replace(/^\.\//, '')}` : relative(root, fragment).split(sep).join('/');
  return { name: dep.name, version: dep.version, entry: (dep.main ?? 'lib/index.js').replace(/^\.\//, ''), fragment, fragmentRel };
}

/** Fragments of the app's whole installed dependency closure, so every package config file the walk loads is listed. */
export function locateFragments(appRoot: string): Promise<FragmentLocation[]> {
  const root = resolve(appRoot);
  const pkg = readPackageJson(join(root, 'package.json'));
  const require = createRequire(join(root, 'package.json'));
  const out = dependencyClosure(root, pkg.name)
    .map((name) => locateFragment(root, name, require))
    .filter((l): l is FragmentLocation => l !== undefined);
  return Promise.resolve(out);
}
