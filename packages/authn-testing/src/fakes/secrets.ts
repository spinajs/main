import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SecretStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

export interface SecretRow {
  readonly identity: IdentityRef;
  readonly purpose: string;
  readonly hash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly usedAt: Date | null;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const samePair = (r: SecretRow, identity: IdentityRef, purpose: string) => r.identity.type === identity.type && r.identity.id === identity.id && r.purpose === purpose;

export class MemorySecretStore extends SecretStore {
  private all: SecretRow[] = [];

  async issue(identity: IdentityRef, purpose: string, ttlSeconds: number): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.all = this.all.filter((r) => !samePair(r, identity, purpose));
    this.all.push({ identity, purpose, hash: sha256hex(raw), createdAt: new Date(now), expiresAt: new Date(now + ttlSeconds * 1000), usedAt: null });
    return raw;
  }

  async redeem(identity: IdentityRef, purpose: string, raw: string): Promise<boolean> {
    const given = Buffer.from(sha256hex(raw));
    const now = Date.now();
    let hit = -1;
    this.all.forEach((r, i) => {
      const stored = Buffer.from(r.hash);
      const equal = stored.length === given.length && timingSafeEqual(stored, given);
      if (equal && hit < 0 && samePair(r, identity, purpose) && r.usedAt === null && now < r.expiresAt.getTime()) {
        hit = i;
      }
    });
    if (hit < 0) {
      return false;
    }
    this.all[hit] = { ...this.all[hit], usedAt: new Date(now) };
    return true;
  }

  rows(): readonly SecretRow[] {
    return [...this.all];
  }

  seedHash(identity: IdentityRef, purpose: string, hashHex: string, expiresAt: Date, createdAt: Date): void {
    this.all.push({ identity, purpose, hash: hashHex, expiresAt, createdAt, usedAt: null });
  }
}
