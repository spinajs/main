import { randomUUID } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import type { RawSqlDriver } from '@spinajs/durable';
import { InsertBehaviour, Orm, QueryContext } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import { IDEMPOTENCY_TABLE } from './connection.js';
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

interface IKeyRow {
  Fingerprint: string | null;
  State: 'running' | 'done';
  LeaseUntil: number | string;
  Reply: StoredReply | string | null;
  ExpiresAt: number | string | null;
}

const LOCKING_READ = `SELECT \`Fingerprint\`, \`State\`, \`LeaseUntil\`, \`Reply\`, \`ExpiresAt\` FROM \`${IDEMPOTENCY_TABLE}\` WHERE \`Key\` = ? LOCK IN SHARE MODE`;

function held(row: IKeyRow | undefined, now: number): IdempotencyHeld | undefined {
  if (!row) {
    return undefined;
  }

  const fingerprint = row.Fingerprint ? { fingerprint: row.Fingerprint } : {};
  if (row.State === 'done') {
    if (Number(row.ExpiresAt) <= now) {
      return undefined;
    }
    const reply = typeof row.Reply === 'string' ? (JSON.parse(row.Reply) as StoredReply) : (row.Reply as StoredReply);
    return { state: 'done', reply, ...fingerprint };
  }

  const leaseUntil = Number(row.LeaseUntil);
  return leaseUntil < now ? undefined : { state: 'running', leaseUntil, ...fingerprint };
}

/**
 * `__idempotency` on the `idempotency` connection. Every write is one conditional statement, and the affected-row count
 * decides who won, as in scheduler/src/store/LeaseStore.ts, including its MySQL CLIENT_FOUND_ROWS requirement.
 * The claim is an ignore-on-duplicate insert, never a refused statement, so it never aborts a Postgres transaction.
 *
 * The ORM cannot run a statement beside the transaction open on the connection, so a claim made inside one joins it:
 * the claim commits or rolls back with that transaction, and other callers wait on the row until then. On MySQL the
 * read after an ignored insert is then a locking read (LOCK IN SHARE MODE, which MySQL 5.7 and MariaDB know too),
 * because a REPEATABLE READ snapshot misses the row that refused the insert; it holds the row until the transaction ends.
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

      const current = await this.current(key, opts.now);
      if (current) {
        return current;
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
    return held(row, now);
  }

  protected async current(key: string, now: number): Promise<IdempotencyHeld | undefined> {
    const query = IdempotencyKeyModel.where('Key', key);
    const driver = query.Driver as RawSqlDriver;
    if (driver.CurrentTransaction && driver.Options.Driver.toLowerCase().includes('mysql')) {
      const [row] = (await driver.executeOnDb(LOCKING_READ, [key], QueryContext.Select)) as IKeyRow[];
      return held(row, now);
    }
    const [row] = await onPrimary(query);
    return held(row, now);
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
