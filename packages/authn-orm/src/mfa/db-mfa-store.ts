import { randomUUID } from 'node:crypto';

import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';
import { OrmDriver } from '@spinajs/orm';
import type { WhereBuilder } from '@spinajs/orm';

import { identityKey } from '../identity.js';
import { StoreConnection } from '../support/connection.js';
import type { StoreOptions } from '../support/connection.js';
import { checkedMs, checkedText, columnText, isDuplicate, rowsAffected, selectTime, sha256hex, sqlTime, textMs } from '../support/sql.js';

const MFA = 'authn_mfa';
const CODES = 'authn_recovery_code';
/** Each retry means a parallel `remove` deleted the row between this call's insert and update. */
const MAX_TRIES = 8;

/** One MFA step of an identity as stored. */
export interface MfaRecord {
  /** Cipher text exactly as `put` was given it; this store never encrypts or decrypts. */
  readonly secretEnc: string;
  readonly keyId: string;
  readonly confirmedAt: Date | null;
  /** The last accepted time step. */
  readonly lastStep: number | null;
  readonly createdAt: Date;
}

const stepName = (step: string): string => checkedText(step, 32, 'DbMfaStore: step');

function lastStepOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(n)) throw new UnexpectedServerError(`DbMfaStore: last_step ${String(value)} is not a safe integer`);
  return n;
}

function timeOf(text: string | null): Date | null {
  return text === null ? null : new Date(textMs(text));
}

/**
 * `authn_mfa` and `authn_recovery_code` for MFA steps (authn-totp, N5). Rows are keyed by `identityKey(id)` and
 * the step name. The store keeps cipher text and its key id only (SR-09); recovery codes are stored as hex SHA-256,
 * never raw, and callers normalise a code before passing it. Replay and single use are decided in SQL (SR-15, D10).
 *
 * Without transactions (the sqlite driver shares one handle) `replaceRecoveryCodes` deletes and then inserts: two
 * parallel calls for one identity may leave both sets.
 */
@Singleton()
@Injectable()
export class DbMfaStore {
  private readonly connection: StoreConnection;

  /** DI passes nothing: the Orm's `'default'` connection is resolved on first use. */
  constructor(driver?: OrmDriver, options: StoreOptions = {}) {
    this.connection = new StoreConnection('DbMfaStore', driver, options.container);
  }

  public async get(id: IdentityRef, step: string): Promise<MfaRecord | null> {
    const identity = identityKey(id);
    const name = stepName(step);
    const { driver, dialect } = await this.connection.get();
    const q = driver.select().from(MFA).select('secret_enc').select('key_id').select('last_step');
    const rows = (await selectTime(dialect, selectTime(dialect, q, 'confirmed_at', 'confirmed_text'), 'created_at', 'created_text').where('identity', identity).where('step', name)) as Record<string, unknown>[];
    const r = rows[0];
    if (!r) return null;
    return {
      secretEnc: String(r.secret_enc),
      keyId: String(r.key_id),
      confirmedAt: timeOf(columnText(dialect, r, 'confirmed_at', 'confirmed_text')),
      lastStep: lastStepOf(r.last_step),
      createdAt: timeOf(columnText(dialect, r, 'created_at', 'created_text')) ?? new Date(NaN),
    };
  }

  /** Stores (or replaces) the step: unconfirmed, no accepted time step, created now. */
  public async put(id: IdentityRef, step: string, secretEnc: string, keyId: string): Promise<void> {
    const identity = identityKey(id);
    const name = stepName(step);
    checkedText(secretEnc, Number.MAX_SAFE_INTEGER, 'DbMfaStore: secretEnc');
    checkedText(keyId, 32, 'DbMfaStore: keyId');
    const now = sqlTime(checkedMs(new Date(), 'DbMfaStore.put: the clock'));
    const { driver } = await this.connection.get();

    const fields = { secret_enc: secretEnc, key_id: keyId, confirmed_at: null, last_step: null, created_at: now };
    for (let i = 0; i < MAX_TRIES; i++) {
      try {
        await driver
          .insert()
          .into(MFA)
          .values({ identity, step: name, ...fields });
        return;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
      }
      if (rowsAffected(await driver.update().in(MFA).update(fields).where('identity', identity).where('step', name)) === 1) return;
    }
    throw new UnexpectedServerError(`DbMfaStore.put: the ${name} row kept changing under this call`);
  }

  /** Sets `confirmed_at` (default now); true when the step exists. */
  public async confirm(id: IdentityRef, step: string, at: Date = new Date()): Promise<boolean> {
    const identity = identityKey(id);
    const name = stepName(step);
    const t = sqlTime(checkedMs(at, 'DbMfaStore.confirm: at'));
    const { driver } = await this.connection.get();
    return rowsAffected(await driver.update().in(MFA).update({ confirmed_at: t }).where('identity', identity).where('step', name)) === 1;
  }

  /** True once per time step, and never for a step at or below the last accepted one (SR-15); false when the step does not exist. */
  public async acceptStep(id: IdentityRef, step: string, timeStep: number): Promise<boolean> {
    const identity = identityKey(id);
    const name = stepName(step);
    if (typeof timeStep !== 'number' || !Number.isSafeInteger(timeStep) || timeStep < 0) {
      throw new InvalidArgument('DbMfaStore.acceptStep: timeStep must be a non-negative safe integer');
    }
    const { driver } = await this.connection.get();
    const older = function (this: WhereBuilder<unknown>) {
      this.whereNull('last_step');
      this.orWhere('last_step', '<', timeStep);
    };
    return rowsAffected(await driver.update().in(MFA).update({ last_step: timeStep }).where('identity', identity).where('step', name).where(older)) === 1;
  }

  public async remove(id: IdentityRef, step: string): Promise<void> {
    const identity = identityKey(id);
    const name = stepName(step);
    const { driver } = await this.connection.get();
    await driver.del().from(MFA).where('identity', identity).where('step', name);
  }

  /** Deletes the identity's codes, then stores the SHA-256 of each new one. Empty or repeated codes throw. */
  public async replaceRecoveryCodes(id: IdentityRef, rawCodes: readonly string[]): Promise<void> {
    const identity = identityKey(id);
    if (!Array.isArray(rawCodes)) throw new InvalidArgument('DbMfaStore.replaceRecoveryCodes: rawCodes must be an array');
    const hashes = rawCodes.map((code) => sha256hex(checkedText(code, Number.MAX_SAFE_INTEGER, 'DbMfaStore: a recovery code')));
    if (new Set(hashes).size !== hashes.length) throw new InvalidArgument('DbMfaStore.replaceRecoveryCodes: the codes repeat');
    const { driver } = await this.connection.get();

    await driver.del().from(CODES).where('identity', identity);
    if (hashes.length === 0) return;
    await driver
      .insert()
      .into(CODES)
      .values(hashes.map((code_hash) => ({ id: randomUUID(), identity, code_hash, used_at: null })));
  }

  /** Spends the code in one conditional update; true for exactly one caller. */
  public async redeemRecoveryCode(id: IdentityRef, raw: string): Promise<boolean> {
    const identity = identityKey(id);
    if (typeof raw !== 'string' || raw.length === 0) return false;
    const now = sqlTime(checkedMs(new Date(), 'DbMfaStore.redeemRecoveryCode: the clock'));
    const { driver } = await this.connection.get();
    const r = await driver.update().in(CODES).update({ used_at: now }).where('identity', identity).where('code_hash', sha256hex(raw)).whereNull('used_at');
    return rowsAffected(r) > 0;
  }

  /** Unused codes. */
  public async countRecoveryCodes(id: IdentityRef): Promise<number> {
    const identity = identityKey(id);
    const { driver } = await this.connection.get();
    return ((await driver.select().from(CODES).select('id').where('identity', identity).whereNull('used_at')) as unknown[]).length;
  }

  public async removeRecoveryCodes(id: IdentityRef): Promise<void> {
    const identity = identityKey(id);
    const { driver } = await this.connection.get();
    await driver.del().from(CODES).where('identity', identity);
  }
}
