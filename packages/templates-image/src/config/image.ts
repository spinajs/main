import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'templates-image', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'templates-image', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const image = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
  templates: {
    image: {
      static: {
        portRange: [3000, 4000],
      },
      args: {
        headless: true,
      },
      renderDurationWarning: 5000,
      navigationTimeout: 30000,
      renderTimeout: 30000,
    },
  },
};

export default image;
