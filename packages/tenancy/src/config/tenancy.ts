import { join, normalize, resolve } from 'path';

function dir(path: string): string[] {
  const root = process.env.WORKSPACE_ROOT_PATH ?? process.cwd();
  return [
    resolve(normalize(join(root, 'node_modules', '@spinajs', 'tenancy', 'lib', path))),
    // one up, for when the process runs from an app or build folder
    resolve(normalize(join(root, '../', 'node_modules', '@spinajs', 'tenancy', 'lib', path))),
  ];
}

// The CLI imports every file of system.dirs.cli: listing the hook's folder registers `--tenant` without an import in the app.
const tenancy = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
};

export default tenancy;
