import { _is_object, _is_string, _non_empty, _try_check_arg } from '@spinajs/util';

import type { IdentityRef } from '../contracts/credentials.js';
import type { IdentityStatus, IdentityStore } from '../contracts/identity.js';
import type { Session } from '../contracts/session-state.js';
import type { SessionHandle, SessionIssuer } from '../contracts/session.js';

/** Strategies vouch for these through their own record checks (revocation, expiry, owner status); every other type is asked (D4b). */
export const VOUCHED_TYPES: ReadonlySet<string> = new Set(['service', 'agent']);

function refusal(st: IdentityStatus, opts: RefusalOptions): string | null {
  if (!st.exists) return 'unknown_identity';
  if (st.deleted) return 'deleted';
  if (st.banned) return 'banned';
  if (!st.active) return 'inactive';
  // undefined: the store does not track it, so it cannot refuse.
  if (opts.requireVerifiedAddress === true && st.addressVerified === false) return 'unverified_address';
  return null;
}

export interface RefusalOptions {
  /** `authn.login.requireVerifiedAddress`: refuse an address the store reports unverified. */
  readonly requireVerifiedAddress?: boolean;
}

/** The audit reason of a status that refuses the subject, or null. Only a vouched type skips the store, so an unknown type fails closed (D4, D4b). */
export async function statusRefusal(identities: IdentityStore, subject: IdentityRef, opts: RefusalOptions = {}): Promise<string | null> {
  return VOUCHED_TYPES.has(subject.type) ? null : refusal(await identities.status(subject), opts);
}

/** The stored session of a handle, or null for a malformed handle or an unknown session. */
export async function restoreHandle(sessions: SessionIssuer, h: SessionHandle): Promise<Session | null> {
  const [ok, id] = _try_check_arg(_is_object(), (s: SessionHandle) => s.id, _is_string(_non_empty()))(h, 'session');
  if (!ok) return null;
  return sessions.restore(id);
}
