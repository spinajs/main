import { principalKey } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

/** Column form of a ref: `principalKey`, e.g. `user:<uuid>`. */
export const refKey = (ref: IdentityRef): string => principalKey(ref);

/** Inverse of refKey: the type ends at the first ':' and has ':' and '%' escaped. */
export function refOf(key: unknown): IdentityRef | undefined {
  if (typeof key !== 'string') {
    return undefined;
  }
  const at = key.indexOf(':');
  if (at <= 0) {
    return undefined;
  }
  return { type: key.slice(0, at).replace(/%(25|3A)/g, (_, code: string) => (code === '25' ? '%' : ':')), id: key.slice(at + 1) };
}

/**
 * Presents whatever the driver hands back for `user_sessions.Data` in one of the
 * two shapes `decodeSessionData` understands - a JSON string, or an
 * already-parsed object graph.
 *
 * `Data` is a MySQL `json` column, so mysql2 parses it and the object passes
 * straight through; sqlite returns the stored text. Only a `Buffer` (a blob-ish
 * column, a driver in binary mode) is converted, to text: walked as an object
 * graph it would decode to an empty session.
 *
 * The write path stores the string from `encodeSessionData`, which a `json`
 * column accepts verbatim; `DbSession.Data` carries no `@Json()` decorator, or
 * the ORM would encode it twice.
 */
export function sessionDataFromColumn(data: unknown): unknown {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  return data;
}
