import { randomUUID } from 'node:crypto';

import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';
import { RawQuery, modelDriver, ormReady } from '@spinajs/orm';
import { _between, _check_arg, _integer, _is_array, _is_number, _is_string, _max_length, _non_empty, _try_check_arg } from '@spinajs/util';
import type { WhereBuilder } from '@spinajs/orm';
import type { DateTime } from 'luxon';

import { identityKey } from '../identity.js';
import { AuthnMfa } from '../models/AuthnMfa.js';
import { AuthnRecoveryCode } from '../models/AuthnRecoveryCode.js';
import { checkedMs, checkedText, dateOf, driverDialect, instant, isDuplicate, sha256hex } from '../support/sql.js';
import type { Dialect } from '../support/sql.js';
import { columnValues } from '../support/values.js';

/** Each retry means a parallel `remove` deleted the row between this call's insert and update. */
const MAX_TRIES = 8;
/** As DbSecretStore: longer input is refused before hashing. */
const RAW_MAX = 1024;

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

/**
 * `secret_enc = ?` where the plain comparison is wrong: `secret_enc` is TEXT, which SQL Server cannot compare with
 * `=`, and MySQL compares under a case-blind collation by default. Undefined: the plain comparison is exact.
 */
function exactSecretEnc(dialect: Dialect, value: string): RawQuery | undefined {
  switch (dialect) {
    case 'mssql':
      return RawQuery.create('CAST([secret_enc] AS NVARCHAR(MAX)) = ?', [value]);
    case 'mysql':
      return RawQuery.create('CAST(`secret_enc` AS BINARY) = ?', [value]);
    default:
      return undefined;
  }
}

const confirmed = (r: AuthnMfa): boolean => r.confirmed_at !== null && r.confirmed_at !== undefined;

/** The columns `put` and `putPending` write: unconfirmed, no accepted time step. */
function pending(secretEnc: string, keyId: string, createdAt: DateTime): Partial<AuthnMfa> {
  return columnValues<AuthnMfa>({ secret_enc: secretEnc, key_id: keyId, confirmed_at: null, last_step: null, created_at: createdAt });
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
  public async get(id: IdentityRef, step: string): Promise<MfaRecord | null> {
    const identity = identityKey(id);
    const name = stepName(step);
    await ormReady();
    const rows = await AuthnMfa.query().columns(['identity', 'step', 'secret_enc', 'key_id', 'last_step', 'confirmed_at', 'created_at']).where('identity', identity).where('step', name);
    const r = rows.find((x) => x.identity === identity && x.step === name);
    if (!r) return null;
    return {
      secretEnc: r.secret_enc,
      keyId: r.key_id,
      confirmedAt: r.confirmed_at ? dateOf(r.confirmed_at) : null,
      lastStep: lastStepOf(r.last_step),
      createdAt: dateOf(r.created_at),
    };
  }

  /** Stores (or replaces) the step: unconfirmed, no accepted time step, created now. */
  public async put(id: IdentityRef, step: string, secretEnc: string, keyId: string): Promise<void> {
    const identity = identityKey(id);
    const name = stepName(step);
    checkedText(secretEnc, Number.MAX_SAFE_INTEGER, 'DbMfaStore: secretEnc');
    checkedText(keyId, 32, 'DbMfaStore: keyId');
    const ms = checkedMs(new Date(), 'DbMfaStore.put: the clock');
    await ormReady();

    const fields = pending(secretEnc, keyId, instant(ms));
    for (let i = 0; i < MAX_TRIES; i++) {
      try {
        await AuthnMfa.insert({ identity, step: name, ...fields });
        return;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
      }
      if ((await AuthnMfa.update(fields).where('identity', identity).where('step', name)).RowsAffected === 1) return;
    }
    throw new UnexpectedServerError(`DbMfaStore.put: the ${name} row kept changing under this call`);
  }

  /**
   * As `put`, but never overwrites a confirmed step: false means a confirmed row exists and nothing changed. The
   * replacing update is conditional on `confirmed_at IS NULL`, so a confirmation that lands first always wins.
   */
  public async putPending(id: IdentityRef, step: string, secretEnc: string, keyId: string): Promise<boolean> {
    const identity = identityKey(id);
    const name = stepName(step);
    checkedText(secretEnc, Number.MAX_SAFE_INTEGER, 'DbMfaStore: secretEnc');
    checkedText(keyId, 32, 'DbMfaStore: keyId');
    const ms = checkedMs(new Date(), 'DbMfaStore.putPending: the clock');
    await ormReady();

    const fields = pending(secretEnc, keyId, instant(ms));
    for (let i = 0; i < MAX_TRIES; i++) {
      try {
        await AuthnMfa.insert({ identity, step: name, ...fields });
        return true;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
      }
      if ((await AuthnMfa.update(fields).where('identity', identity).where('step', name).whereNull('confirmed_at')).RowsAffected === 1) return true;
      // No row updated: either it is confirmed, or a parallel remove deleted it and the insert is worth retrying.
      if ((await this.get(id, name))?.confirmedAt) return false;
    }
    throw new UnexpectedServerError(`DbMfaStore.putPending: the ${name} row kept changing under this call`);
  }

  /**
   * Sets `confirmed_at` (default now); true when the step exists. With `expectedSecretEnc`, only an unconfirmed step
   * holding that cipher text is confirmed, so the answer is true for exactly the call that confirmed it.
   */
  public async confirm(id: IdentityRef, step: string, at: Date = new Date(), expectedSecretEnc?: string): Promise<boolean> {
    const identity = identityKey(id);
    const name = stepName(step);
    const ms = checkedMs(at, 'DbMfaStore.confirm: at');
    if (expectedSecretEnc !== undefined) checkedText(expectedSecretEnc, Number.MAX_SAFE_INTEGER, 'DbMfaStore: expectedSecretEnc');
    await ormReady();
    const q = AuthnMfa.update({ confirmed_at: instant(ms) })
      .where('identity', identity)
      .where('step', name);
    if (expectedSecretEnc !== undefined) {
      const exact = exactSecretEnc(driverDialect(modelDriver(AuthnMfa)), expectedSecretEnc);
      q.whereNull('confirmed_at');
      if (exact) q.where(exact);
      else q.where('secret_enc', expectedSecretEnc);
    }
    return (await q).RowsAffected === 1;
  }

  /** True once per time step, and never for a step at or below the last accepted one (SR-15); false when the step does not exist. */
  public async acceptStep(id: IdentityRef, step: string, timeStep: number): Promise<boolean> {
    const identity = identityKey(id);
    const name = stepName(step);
    _check_arg(_is_number(_integer(), _between(0, Number.MAX_SAFE_INTEGER)))(timeStep, 'timeStep');
    await ormReady();
    const older = function (this: WhereBuilder<unknown>) {
      this.whereNull('last_step');
      this.orWhere('last_step', '<', timeStep);
    };
    return (await AuthnMfa.update({ last_step: timeStep }).where('identity', identity).where('step', name).where(older)).RowsAffected === 1;
  }

  public async remove(id: IdentityRef, step: string): Promise<void> {
    const identity = identityKey(id);
    const name = stepName(step);
    await ormReady();
    await AuthnMfa.destroy().where('identity', identity).where('step', name);
  }

  /** The names of the identity's confirmed steps. */
  public async confirmedSteps(id: IdentityRef): Promise<string[]> {
    const identity = identityKey(id);
    await ormReady();
    const rows = await AuthnMfa.query().columns(['identity', 'step', 'confirmed_at']).where('identity', identity).whereNotNull('confirmed_at');
    return rows.filter((r) => r.identity === identity && confirmed(r)).map((r) => r.step);
  }

  /**
   * Each step name with a confirmed row of any identity, once. Deduplicated here, not with DISTINCT, which folds
   * `totp` and `TOTP` into one under a case-blind collation (MySQL's default); one row per confirmed enrolment.
   */
  public async confirmedStepNames(): Promise<string[]> {
    await ormReady();
    const rows = await AuthnMfa.query().columns(['step', 'confirmed_at']).whereNotNull('confirmed_at');
    return [...new Set(rows.filter(confirmed).map((r) => r.step))];
  }

  /** Deletes the identity's codes, then stores the SHA-256 of each new one. Empty or repeated codes throw. */
  public async replaceRecoveryCodes(id: IdentityRef, rawCodes: readonly string[]): Promise<void> {
    const identity = identityKey(id);
    _check_arg(_is_array())(rawCodes, 'rawCodes');
    const hashes = rawCodes.map((code) => sha256hex(checkedText(code, Number.MAX_SAFE_INTEGER, 'DbMfaStore: a recovery code')));
    if (new Set(hashes).size !== hashes.length) throw new InvalidArgument('DbMfaStore.replaceRecoveryCodes: the codes repeat');
    await ormReady();

    await AuthnRecoveryCode.destroy().where('identity', identity);
    if (hashes.length === 0) return;
    await AuthnRecoveryCode.insert(hashes.map((code_hash) => columnValues<AuthnRecoveryCode>({ id: randomUUID(), identity, code_hash, used_at: null })));
  }

  /** Spends the code in one conditional update; true for exactly one caller. */
  public async redeemRecoveryCode(id: IdentityRef, raw: string): Promise<boolean> {
    const identity = identityKey(id);
    if (!_try_check_arg(_is_string(_non_empty(), _max_length(RAW_MAX)))(raw, 'raw')[0]) return false;
    const ms = checkedMs(new Date(), 'DbMfaStore.redeemRecoveryCode: the clock');
    await ormReady();
    const r = await AuthnRecoveryCode.update({ used_at: instant(ms) })
      .where('identity', identity)
      .where('code_hash', sha256hex(raw))
      .whereNull('used_at');
    return r.RowsAffected > 0;
  }

  /** Unused codes. */
  public async countRecoveryCodes(id: IdentityRef): Promise<number> {
    const identity = identityKey(id);
    await ormReady();
    const rows = await AuthnRecoveryCode.query().columns(['identity']).where('identity', identity).whereNull('used_at');
    return rows.filter((r) => r.identity === identity).length;
  }

  public async removeRecoveryCodes(id: IdentityRef): Promise<void> {
    const identity = identityKey(id);
    await ormReady();
    await AuthnRecoveryCode.destroy().where('identity', identity);
  }
}
