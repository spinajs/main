import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

export interface FragmentLocation {
  name: string;
  version: string;
  entry: string;
  /** Absolute path to the dependency's manifest fragment. */
  fragment: string;
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
    out.push({ name: dep.name, version: dep.version, entry: (dep.main ?? 'lib/index.js').replace(/^\.\//, ''), fragment });
  }
  return Promise.resolve(out);
}
