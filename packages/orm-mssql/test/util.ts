/* eslint-disable @typescript-eslint/no-explicit-any */
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}
