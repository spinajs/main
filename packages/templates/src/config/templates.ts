import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.cwd(), 'node_modules', '@spinajs', 'rbac', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.cwd(),'../','node_modules', '@spinajs', 'rbac', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const templates = {
  system: {
    dirs: {
      templates: [...dir('templates')],
      cli: [...dir('cli')],
    },
  },
};

export default templates;
