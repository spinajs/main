// Apart from resource.ts: errors.ts imports resourceKey, so resource.ts cannot import AuthzConfigError back.
import { AuthzConfigError } from './errors.js';
import type { ResourceRef } from './principal.js';

const ESCAPED_TYPE = /^(?:[^%:/]|%(?:25|3A|2F))*$/;
const UNESCAPE: Readonly<Record<string, string>> = { '%25': '%', '%3A': ':', '%2F': '/' };

/** The inverse of `resourceKey`: the ref a key was made from. */
export function parseResourceKey(key: string): ResourceRef {
  if (typeof key !== 'string') throw new AuthzConfigError(`parseResourceKey: ${JSON.stringify(key)} is not a resource key`);
  const at = key.indexOf(':');
  const escaped = at < 0 ? key : key.slice(0, at);
  if (!ESCAPED_TYPE.test(escaped)) throw new AuthzConfigError(`parseResourceKey: ${JSON.stringify(key)} is not a resource key`);
  const type = escaped.replace(/%(?:25|3A|2F)/g, (e) => UNESCAPE[e]);
  return at < 0 ? { type } : { type, id: key.slice(at + 1) };
}
