import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';
import { identityKey } from '@spinajs/authn-orm/identity';

import { WebAuthnCredentialExists, WebAuthnCredentialStore } from '../contracts.js';
import type { WebAuthnCredential } from '../contracts.js';
import { checkedCounter, checkedCredential, checkedCredentialId } from './checks.js';

const copy = (c: WebAuthnCredential): WebAuthnCredential =>
  Object.freeze({
    ...c,
    identity: Object.freeze({ type: c.identity.type, id: c.identity.id }),
    publicKey: new Uint8Array(c.publicKey),
    ...(c.transports ? { transports: Object.freeze([...c.transports]) } : {}),
    createdAt: new Date(c.createdAt.getTime()),
    ...(c.lastUsedAt ? { lastUsedAt: new Date(c.lastUsedAt.getTime()) } : {}),
  });

/** In-process store for tests and single-process apps; it loses every credential on restart. */
export class MemoryWebAuthnCredentialStore extends WebAuthnCredentialStore {
  private readonly rows = new Map<string, WebAuthnCredential>();

  async add(c: WebAuthnCredential): Promise<void> {
    const row = checkedCredential(c);
    if (this.rows.has(row.credentialId)) throw new WebAuthnCredentialExists('the WebAuthn credential is registered already');
    this.rows.set(row.credentialId, copy(row));
  }

  async get(credentialId: string): Promise<WebAuthnCredential | null> {
    const row = typeof credentialId === 'string' ? this.rows.get(credentialId) : undefined;
    return row ? copy(row) : null;
  }

  async listFor(id: IdentityRef): Promise<readonly WebAuthnCredential[]> {
    const key = identityKey(id);
    return [...this.rows.values()].filter((r) => identityKey(r.identity) === key).map(copy);
  }

  async advance(credentialId: string, expected: number, next: number, at: Date): Promise<boolean> {
    checkedCredentialId(credentialId);
    checkedCounter(expected, 'expected');
    checkedCounter(next, 'next');
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new InvalidArgument('MemoryWebAuthnCredentialStore.advance: at must be a valid date');
    const row = this.rows.get(credentialId);
    if (!row || row.counter !== expected) return false;
    this.rows.set(credentialId, Object.freeze({ ...row, counter: next, lastUsedAt: new Date(at.getTime()) }));
    return true;
  }

  async remove(id: IdentityRef, credentialId: string): Promise<boolean> {
    const key = identityKey(id);
    const row = typeof credentialId === 'string' ? this.rows.get(credentialId) : undefined;
    if (!row || identityKey(row.identity) !== key) return false;
    return this.rows.delete(credentialId);
  }
}
