import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'templates-pdf', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'templates-pdf', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const pdf = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
  templates: {
    pdf: {
      static: {
        portRange: [3000, 4000],
      },
      args: {
        headless: true,
      },
      options: {},
    },
  },
};

export default pdf;
