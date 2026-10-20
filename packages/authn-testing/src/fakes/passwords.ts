import { createHash, timingSafeEqual } from 'node:crypto';
import { PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** The fakes' hash: 'fake$' + sha256hex(password). Never used by real lanes. */
export function fakeHash(password: string): string {
  return 'fake$' + createHash('sha256').update(password).digest('hex');
}

export function fakeVerify(hash: string, password: string): boolean {
  return timingSafeEqual(digest(hash), digest(fakeHash(password)));
}

export const FAKE_DUMMY_HASH: string = fakeHash('authn-testing dummy');

export class MemoryPasswordCredentialStore extends PasswordCredentialStore {
  readonly writes: { id: IdentityRef; hash: string }[] = [];
  private readonly hashes = new Map<string, string>();

  async get(id: IdentityRef): Promise<string | null> {
    return this.hashes.get(`${id.type}:${id.id}`) ?? null;
  }

  async set(id: IdentityRef, hash: string, expected?: string | null): Promise<boolean> {
    const key = `${id.type}:${id.id}`;
    if (expected !== undefined && (this.hashes.get(key) ?? null) !== expected) {
      return false;
    }
    this.hashes.set(key, hash);
    this.writes.push({ id, hash });
    return true;
  }
}
