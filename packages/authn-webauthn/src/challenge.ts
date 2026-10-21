import { randomBytes } from 'node:crypto';
import { PasskeyChallengesFull } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { CHALLENGE_ID_MAX, checkedChallenge } from './store/checks.js';

/** What a challenge was issued for: a credential registration, a passkey login, or the WebAuthn MFA step. */
export type WebAuthnCeremony = 'register' | 'login' | 'mfa';

export interface WebAuthnChallenge {
  /** base64url, 128 bits; names the challenge to the client. */
  readonly id: string;
  /** base64url, 256 bits; what the authenticator signs. */
  readonly challenge: string;
  readonly purpose: WebAuthnCeremony;
  /** The identity a registration or MFA challenge was issued to; absent for a login. */
  readonly identity?: IdentityRef;
  readonly expiresAt: Date;
}

/** Issued challenges until they are taken or expire. `DbWebAuthnChallengeStore` (`@spinajs/authn-webauthn/db`) shares them between processes. */
export abstract class WebAuthnChallengeStore {
  /** With `maxRows`, throws PasskeyChallengesFull instead of storing past that many rows. */
  abstract put(c: WebAuthnChallenge, maxRows?: number): Promise<void>;
  /** Single use: the challenge once, then null; null as well when it is expired at `now`. */
  abstract take(id: string, now: Date): Promise<WebAuthnChallenge | null>;
}

const validDate = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime());

/** In-process store for tests and single-process apps. */
export class MemoryWebAuthnChallengeStore extends WebAuthnChallengeStore {
  private readonly rows = new Map<string, WebAuthnChallenge>();

  async put(c: WebAuthnChallenge, maxRows?: number): Promise<void> {
    const row = checkedChallenge(c);
    this.sweep(new Date());
    if (maxRows !== undefined && this.rows.size >= maxRows) throw new PasskeyChallengesFull();
    this.rows.set(row.id, Object.freeze({ ...row, ...(row.identity ? { identity: Object.freeze({ type: row.identity.type, id: row.identity.id }) } : {}), expiresAt: new Date(row.expiresAt.getTime()) }));
  }

  async take(id: string, now: Date): Promise<WebAuthnChallenge | null> {
    if (typeof id !== 'string' || !validDate(now)) return null;
    const row = this.rows.get(id);
    if (!row) return null;
    this.rows.delete(id);
    return row.expiresAt.getTime() > now.getTime() ? { ...row, expiresAt: new Date(row.expiresAt.getTime()) } : null;
  }

  private sweep(now: Date): void {
    for (const [id, row] of this.rows) if (row.expiresAt.getTime() <= now.getTime()) this.rows.delete(id);
  }
}

/** A fresh challenge of `purpose`, live for `ttlSeconds` from `now`. */
export function newChallenge(purpose: WebAuthnCeremony, now: Date, ttlSeconds: number, identity?: IdentityRef): WebAuthnChallenge {
  return {
    id: randomBytes(16).toString('base64url'),
    challenge: randomBytes(32).toString('base64url'),
    purpose,
    ...(identity ? { identity: { type: identity.type, id: identity.id } } : {}),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
  };
}

/**
 * Takes challenge `id` from `store`: null unless it is live at `now` and was issued for `purpose` and, when `identity` is
 * given, to that identity. A challenge of another purpose or identity is used up all the same.
 */
export async function takeChallenge(store: WebAuthnChallengeStore, id: unknown, purpose: WebAuthnCeremony, now: Date, identity?: IdentityRef): Promise<WebAuthnChallenge | null> {
  if (typeof id !== 'string' || id === '' || id.length > CHALLENGE_ID_MAX) return null;
  const c = await store.take(id, now);
  if (!c || c.purpose !== purpose) return null;
  if (identity === undefined) return c.identity === undefined ? c : null;
  return c.identity && c.identity.type === identity.type && c.identity.id === identity.id ? c : null;
}
