import { createHash } from 'node:crypto';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';
import { identityKey } from './identity.js';
import { MfaSecretStore } from './store.js';
import type { MfaRecord } from './store.js';

const MAX_STEP = 32;

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function text(value: unknown, what: string, max = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new InvalidArgument(`MemoryMfaSecretStore: ${what} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

const rowKey = (id: IdentityRef, step: string): string => JSON.stringify([identityKey(id), text(step, 'step', MAX_STEP)]);

const copy = (row: MfaRecord): MfaRecord => Object.freeze({ ...row, confirmedAt: row.confirmedAt && new Date(row.confirmedAt.getTime()), createdAt: new Date(row.createdAt.getTime()) });

/** In-process store for tests and single-process apps; it loses every enrolment on restart. */
export class MemoryMfaSecretStore extends MfaSecretStore {
  private readonly rows = new Map<string, MfaRecord>();
  /** identity key -> code hash -> used */
  private readonly codes = new Map<string, Map<string, boolean>>();

  async get(id: IdentityRef, step: string): Promise<MfaRecord | null> {
    const row = this.rows.get(rowKey(id, step));
    return row ? copy(row) : null;
  }

  async put(id: IdentityRef, step: string, secretEnc: string, keyId: string): Promise<boolean> {
    const key = rowKey(id, step);
    const row: MfaRecord = Object.freeze({ secretEnc: text(secretEnc, 'secretEnc'), keyId: text(keyId, 'keyId', 32), confirmedAt: null, lastStep: null, createdAt: new Date() });
    if (this.rows.get(key)?.confirmedAt) {
      return false;
    }
    this.rows.set(key, row);
    return true;
  }

  async confirm(id: IdentityRef, step: string, at: Date = new Date()): Promise<boolean> {
    const key = rowKey(id, step);
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
      throw new InvalidArgument('MemoryMfaSecretStore.confirm: at must be a valid date');
    }
    const row = this.rows.get(key);
    if (!row) {
      return false;
    }
    this.rows.set(key, Object.freeze({ ...row, confirmedAt: new Date(at.getTime()) }));
    return true;
  }

  async acceptStep(id: IdentityRef, step: string, timeStep: number): Promise<boolean> {
    const key = rowKey(id, step);
    if (typeof timeStep !== 'number' || !Number.isSafeInteger(timeStep) || timeStep < 0) {
      throw new InvalidArgument('MemoryMfaSecretStore.acceptStep: timeStep must be a non-negative safe integer');
    }
    const row = this.rows.get(key);
    if (!row || (row.lastStep !== null && row.lastStep >= timeStep)) {
      return false;
    }
    this.rows.set(key, Object.freeze({ ...row, lastStep: timeStep }));
    return true;
  }

  async remove(id: IdentityRef, step: string): Promise<void> {
    this.rows.delete(rowKey(id, step));
  }

  async replaceRecoveryCodes(id: IdentityRef, rawCodes: readonly string[]): Promise<void> {
    const identity = identityKey(id);
    if (!Array.isArray(rawCodes)) {
      throw new InvalidArgument('MemoryMfaSecretStore.replaceRecoveryCodes: rawCodes must be an array');
    }
    const hashes = rawCodes.map((code) => sha256hex(text(code, 'a recovery code')));
    if (new Set(hashes).size !== hashes.length) {
      throw new InvalidArgument('MemoryMfaSecretStore.replaceRecoveryCodes: the codes repeat');
    }
    this.codes.set(identity, new Map(hashes.map((h) => [h, false])));
  }

  async redeemRecoveryCode(id: IdentityRef, raw: string): Promise<boolean> {
    const set = this.codes.get(identityKey(id));
    if (typeof raw !== 'string' || raw.length === 0 || !set) {
      return false;
    }
    const hash = sha256hex(raw);
    if (set.get(hash) !== false) {
      return false;
    }
    set.set(hash, true);
    return true;
  }

  async countRecoveryCodes(id: IdentityRef): Promise<number> {
    return [...(this.codes.get(identityKey(id))?.values() ?? [])].filter((used) => !used).length;
  }

  async removeRecoveryCodes(id: IdentityRef): Promise<void> {
    this.codes.delete(identityKey(id));
  }

  /** What the store holds for the identity's recovery codes (SHA-256 hex), for storage checks in tests. */
  recoveryCodeHashes(id: IdentityRef): readonly string[] {
    return [...(this.codes.get(identityKey(id))?.keys() ?? [])];
  }
}
