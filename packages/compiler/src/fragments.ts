import { existsSync, readFileSync } from 'node:fs';
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
  spinajs?: { manifest?: string };
}

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

/** A package restricting `exports` hides its package.json from `require.resolve`, hence the node_modules fallback. */
function packageJsonPath(root: string, name: string, require: NodeRequire): string | undefined {
  try {
    return require.resolve(`${name}/package.json`);
  } catch {
    const direct = join(root, 'node_modules', name, 'package.json');
    return existsSync(direct) ? direct : undefined;
  }
}

export function locateFragments(appRoot: string): Promise<FragmentLocation[]> {
  const root = resolve(appRoot);
  const pkg = readPackageJson(join(root, 'package.json'));
  const require = createRequire(join(root, 'package.json'));
  const out: FragmentLocation[] = [];

  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
    const depPkgPath = packageJsonPath(root, name, require);
    if (!depPkgPath) continue;
    const dep = readPackageJson(depPkgPath);
    if (!dep.spinajs?.manifest) continue;
    const fragment = join(dirname(depPkgPath), dep.spinajs.manifest);
    if (!existsSync(fragment)) continue;
    const installed = existsSync(join(root, 'node_modules', name));
    const fragmentRel = installed ? `node_modules/${name}/${dep.spinajs.manifest.replace(/^\.\//, '')}` : relative(root, fragment).split(sep).join('/');
    out.push({ name: dep.name, version: dep.version, entry: (dep.main ?? 'lib/index.js').replace(/^\.\//, ''), fragment, fragmentRel });
  }
  return Promise.resolve(out);
}
