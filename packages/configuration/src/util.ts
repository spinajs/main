import * as fs from 'fs';
import _ = require('lodash');
import { join, resolve } from 'path';

/**
 * Hack to inform ts that jasmine var is declared to skip syntax error
 */
declare var jasmine: any;

export function parseArgv(param: string): string {
  const index = process.argv.indexOf(param);

  if (index === -1 || process.argv.length <= index + 1) {
    return undefined;
  }

  return process.argv[index + 1];
}

export function findBasePath(path: string): string {
  if (fs.existsSync(join(path, 'node_modules'))) {
    return path;
  }

  return findBasePath(resolve(path, '..'));
}

export function merge(to: any, from: any): void {
  _.mergeWith(to, from, (src, dest) => {
    if (_.isArray(src) && _.isArray(dest)) {
      const tmp = src.concat(dest);
      return _.uniqWith(tmp, _.isEqual);
    } else if (!src) {
      return dest;
    }
  });

  return to;
}

// clean require cache config
// http://stackoverflow.com/questions/9210542/node-js-require-cache-possible-to-invalidate
export function uncache(file: string) {
  delete require.cache[file];
  return file;
}

export function filterDirs(dir: string) {
  if (fs.existsSync(dir)) {
    return true;
  }
  return false;
}
