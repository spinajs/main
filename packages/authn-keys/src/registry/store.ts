import type { Ceiling, IdentityRef, KeyRecord, PrincipalRef } from '@spinajs/authn/contracts';
import { principalKey } from '@spinajs/authn/contracts';

/** authn_key behind DefaultKeyRegistry: MemoryKeyStore, or OrmKeyStore in apps. */
export abstract class KeyStore {
  /** 'duplicate' when the kid or the thumbprint is taken, also when another insert won a race. */
  abstract insert(key: KeyRecord): Promise<'inserted' | 'duplicate'>;
  abstract get(kid: string): Promise<KeyRecord | null>;
  abstract listByOwner(owner: IdentityRef): Promise<readonly KeyRecord[]>;
  /** Sets revokedAt unless already set; false when the key does not exist or belongs to another owner (type and id). */
  abstract revoke(owner: IdentityRef, kid: string, at: Date): Promise<boolean>;
  abstract touch(kid: string, at: Date): Promise<void>;
}

export const sameOwner = (a: IdentityRef, b: IdentityRef): boolean => a.type === b.type && a.id === b.id;

export function encodePrincipalRef(ref: PrincipalRef): string {
  return principalKey(ref);
}

export function decodePrincipalRef(text: string): PrincipalRef {
  const at = text.indexOf(':');
  return { type: decodeURIComponent(text.slice(0, at)), id: text.slice(at + 1) };
}

export function encodeCeiling(scope: Ceiling): string {
  return JSON.stringify(scope);
}

export function decodeCeiling(text: string): Ceiling {
  const raw = JSON.parse(text) as Ceiling & { expiresAt?: string };
  return Object.freeze(raw.expiresAt === undefined ? raw : { ...raw, expiresAt: new Date(raw.expiresAt) });
}

const freeze = (k: KeyRecord): KeyRecord => Object.freeze({ ...k, owner: Object.freeze({ ...k.owner }), jwk: Object.freeze({ ...k.jwk }) }) as KeyRecord;

/** In-process authn_key, for tests and single-process apps. */
export class MemoryKeyStore extends KeyStore {
  private readonly rows = new Map<string, KeyRecord>();

  async insert(key: KeyRecord): Promise<'inserted' | 'duplicate'> {
    if (this.rows.has(key.kid) || [...this.rows.values()].some((r) => r.thumbprint === key.thumbprint)) {
      return 'duplicate';
    }
    this.rows.set(key.kid, freeze(key));
    return 'inserted';
  }

  async get(kid: string): Promise<KeyRecord | null> {
    return this.rows.get(kid) ?? null;
  }

  async listByOwner(owner: IdentityRef): Promise<readonly KeyRecord[]> {
    return [...this.rows.values()].filter((r) => sameOwner(r.owner, owner));
  }

  async revoke(owner: IdentityRef, kid: string, at: Date): Promise<boolean> {
    const row = this.rows.get(kid);
    if (!row || !sameOwner(row.owner, owner)) {
      return false;
    }
    if (!row.revokedAt) {
      this.rows.set(kid, freeze({ ...row, revokedAt: at }));
    }
    return true;
  }

  async touch(kid: string, at: Date): Promise<void> {
    const row = this.rows.get(kid);
    if (row) {
      this.rows.set(kid, freeze({ ...row, lastUsedAt: at }));
    }
  }
}
