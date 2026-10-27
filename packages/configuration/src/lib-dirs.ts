import { join, normalize, resolve } from 'path';

/**
 * Where `sub` of the installed package `pkg` (eg. `@spinajs/authn-token`) builds to, for its config's `system.dirs`:
 * under `node_modules` of WORKSPACE_ROOT_PATH (else the working directory), then one level up for a process that runs
 * from an app or build folder.
 */
export function packageLibDirs(pkg: string, sub: string): string[] {
  const root = process.env.WORKSPACE_ROOT_PATH ?? process.cwd();
  return [resolve(normalize(join(root, 'node_modules', pkg, 'lib', sub))), resolve(normalize(join(root, '../', 'node_modules', pkg, 'lib', sub)))];
}
