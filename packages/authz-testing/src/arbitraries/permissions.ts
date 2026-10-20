import * as fc from 'fast-check';

import { DEFAULT_PERMISSIONS, fromPool, word } from './common.js';

export interface PermissionOptions {
  /** Fixed names to draw from; otherwise a mix of the default pool and random names. */
  readonly pool?: readonly string[];
}

const PART = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_.-]{0,6}$/);
const part = (): fc.Arbitrary<string> => PART;

export function permissionName(opts: PermissionOptions = {}): fc.Arbitrary<string> {
  if (opts.pool?.length) return fromPool(opts.pool);
  const random = fc.tuple(part(), part()).map(([r, a]) => `${r}:${a}`);
  return fc.oneof({ weight: 3, arbitrary: fromPool(DEFAULT_PERMISSIONS) }, { weight: 1, arbitrary: random });
}

// '**' stays invalid, so runs of stars are collapsed.
const globPart = (name: string): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constant(name),
    fc.constant('*'),
    fc.integer({ min: 0, max: name.length }).map((k) => `${name.slice(0, k)}*`),
    fc.integer({ min: 0, max: name.length }).map((k) => `*${name.slice(k)}`),
    fc.integer({ min: 0, max: name.length }).map((k) => `${name.slice(0, k)}*${name.slice(k)}`),
  ).map((g) => g.replace(/\*+/g, '*'));

/** Valid globs: '*' alone, or <resource-glob>:<action-glob>. Derived from names, so they tend to match something. */
export function permissionGlob(opts: PermissionOptions = {}): fc.Arbitrary<string> {
  const fromName = permissionName(opts).chain((name) => {
    const at = name.indexOf(':');
    return fc.tuple(globPart(name.slice(0, at)), globPart(name.slice(at + 1))).map(([r, a]) => `${r}:${a}`);
  });
  const free = fc.tuple(word(), word()).map(([r, a]) => `${r}*:*${a}`);
  return fc.oneof({ weight: 1, arbitrary: fc.constant('*') }, { weight: 6, arbitrary: fromName }, { weight: 1, arbitrary: free });
}
