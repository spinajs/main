import { randomUUID } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { InsertBehaviour, Orm } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import { fitsColumn, positive } from './guards.js';
import { IdempotencyKeyModel } from './models/IdempotencyKeyModel.js';
import { onPrimary } from './sql.js';
import { IdempotencyStore } from './store.js';
import type { IdempotencyClaim, IdempotencyClaimOptions, IdempotencyHeld, StoredReply } from './interfaces.js';

const NAMESPACE_LENGTH = 128;
// A key swept between the ignored insert and the read is free again: claim once more instead of answering nothing.
const CLAIM_ATTEMPTS = 3;

/** A running claim whose lease ended, or a reply past its TTL. */
const free = (now: number) =>
  function (this: IWhereBuilder<unknown>) {
    this.where(function (this: IWhereBuilder<unknown>) {
      this.where('State', 'running').where('LeaseUntil', '<', now);
    }).orWhere(function (this: IWhereBuilder<unknown>) {
      this.where('State', 'done').where('ExpiresAt', '<=', now);
    });
  };

/**
 * `__idempotency` on the `idempotency` connection. Every write is one conditional statement, and the affected-row count
 * decides who won, as in scheduler/src/store/LeaseStore.ts, including its MySQL CLIENT_FOUND_ROWS requirement.
 * The claim is an ignore-on-duplicate insert, never a refused statement: statements join a transaction open on the
 * connection, and Postgres aborts such a transaction on any statement that errors.
 */
@Injectable(IdempotencyStore)
export class OrmIdempotencyStore extends IdempotencyStore {
  public async claim(key: string, opts: IdempotencyClaimOptions): Promise<IdempotencyClaim> {
    positive('leaseMs', opts.leaseMs);
    fitsColumn('key', key);
    fitsColumn('fingerprint', opts.fingerprint);
    const token = randomUUID();
    const values = {
      Namespace: (opts.namespace ?? '').slice(0, NAMESPACE_LENGTH),
      Fingerprint: opts.fingerprint || null,
      State: 'running' as const,
      Token: token,
      LeaseUntil: opts.now + opts.leaseMs,
      Reply: null,
      ExpiresAt: null,
      CreatedAt: opts.now,
    };

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      // INSERT OR IGNORE / ON CONFLICT DO NOTHING / INSERT IGNORE: 0 rows affected when the key is taken
      const inserted = await IdempotencyKeyModel.insert({ Key: key, ...values }, InsertBehaviour.InsertOrIgnore);
      if (inserted.RowsAffected === 1) {
        return { state: 'claimed', token };
      }

      const taken = await IdempotencyKeyModel.update(values).where('Key', key).where(free(opts.now));
      if (taken.RowsAffected === 1) {
        return { state: 'claimed', token };
      }

      const held = await this.peek(key, opts.now);
      if (held) {
        return held;
      }
    }

    throw new UnexpectedServerError(`idempotency key ${key}: ${CLAIM_ATTEMPTS} claims in a row raced a sweep`);
  }

  public async renew(key: string, token: string, leaseMs: number, now: number): Promise<boolean> {
    positive('leaseMs', leaseMs);
    const result = await IdempotencyKeyModel.update({ LeaseUntil: now + leaseMs }).where('Key', key).where('Token', token).where('State', 'running');
    return result.RowsAffected === 1;
  }

  public async complete(key: string, token: string, reply: StoredReply, ttlMs: number, now: number): Promise<boolean> {
    positive('ttlMs', ttlMs);
    const result = await IdempotencyKeyModel.update({ State: 'done', Reply: reply, ExpiresAt: now + ttlMs }).where('Key', key).where('Token', token).where('State', 'running');
    return result.RowsAffected === 1;
  }

  public async release(key: string, token: string): Promise<void> {
    await IdempotencyKeyModel.destroy().where('Key', key).where('Token', token).where('State', 'running');
  }

  public async peek(key: string, now: number): Promise<IdempotencyHeld | undefined> {
    const [row] = await onPrimary(IdempotencyKeyModel.where('Key', key));
    if (!row) {
      return undefined;
    }

    const fingerprint = row.Fingerprint ? { fingerprint: row.Fingerprint } : {};
    if (row.State === 'done') {
      if (Number(row.ExpiresAt) <= now) {
        return undefined;
      }
      return { state: 'done', reply: row.Reply as StoredReply, ...fingerprint };
    }

    const leaseUntil = Number(row.LeaseUntil);
    return leaseUntil < now ? undefined : { state: 'running', leaseUntil, ...fingerprint };
  }

  public async sweep(now: number, limit: number): Promise<number> {
    const rows = await onPrimary(IdempotencyKeyModel.where(free(now)).take(limit));
    if (rows.length === 0) {
      return 0;
    }

    // the WHERE again: a row claimed since the select stays
    const result = await IdempotencyKeyModel.destroy()
      .whereIn(
        'Key',
        rows.map((row) => row.Key),
      )
      .where(free(now));
    return Number(result.RowsAffected);
  }
}

/**
 * false when the Orm of `container` resolved without IdempotencyKeyModel: this package was imported after the Orm read
 * its models and ran its migrations, so `__idempotency` has neither. undefined while the Orm is not resolved.
 */
export function ormModelRegistered(container: IContainer): boolean | undefined {
  const orm = container.get(Orm) as Orm | undefined;
  return orm === undefined ? undefined : orm.Models.some((m) => m.type === IdempotencyKeyModel);
}
