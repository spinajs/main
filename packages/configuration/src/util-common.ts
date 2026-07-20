/* eslint-disable @typescript-eslint/no-unsafe-return */
import { ConfigVar } from '@spinajs/configuration-common';
import _ from 'lodash';

/**
 * Platform-free configuration merge/pick helpers. Split out of util.ts so the
 * browser entry can use them without pulling in fs / path / process.
 */

export function merge(to: unknown, from: unknown): unknown {
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

export function mergeArrays(target: unknown[], source: unknown[]): unknown {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function pickString(obj: { [key: string]: any }): [string, string][] {
  return Object.keys(obj)
    .filter((k) => typeof obj[k] === 'string')
    .map((k) => {
      return [k, obj[k]];
    });
}

export function pickObjects(obj: { [key: string]: any }): [string, any][] {
  return Object.keys(obj)
    .filter((k) => (typeof obj[k] === 'object' || Array.isArray(obj[k])) && obj[k] !== null)
    .map((k) => {
      return [k, obj[k]];
    });
}

/**
 * recursively maps object values
 *
 * @param obj
 * @param fn
 * @returns
 */
export function mapObject(obj: any, fn: (obj: any) => any) {
  if (!_.isPlainObject(obj)) return obj;
  return Object.keys(obj).reduce((acc: any, key: string) => {
    const value = obj[key];
    if (Array.isArray(value)) {
      // only descend into plain objects - class instances (eg. luxon DateTime)
      // must be passed through untouched or they lose their prototype/methods
      acc[key] = value.map((x) => (_.isPlainObject(x) ? fn(mapObject(x, fn)) : x));
    } else if (_.isPlainObject(value) && !(value instanceof ConfigVar)) {
      acc[key] = fn(mapObject(value, fn));
    } else {
      acc[key] = value;
    }
    return acc;
  }, {});
}
