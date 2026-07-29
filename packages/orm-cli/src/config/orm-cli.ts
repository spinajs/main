import { join, normalize, resolve } from 'path';

/**
 * Mirrors `@spinajs/cli`'s own config: `Cli` discovers commands by scanning `system.dirs.cli`,
 * so a package that ships commands has to add its own command directory to that list or the
 * classes are never handed to commander. `system.dirs.cli` is merged by concatenation, so this
 * appends to whatever `@spinajs/cli` and the application already declared.
 */
function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';

  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'orm-cli', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up, for when the process runs from an app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'orm-cli', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const ormCli = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
};

export default ormCli;
