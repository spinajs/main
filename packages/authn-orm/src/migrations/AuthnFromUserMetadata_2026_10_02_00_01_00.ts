import { randomUUID } from 'node:crypto';

import { Configuration } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { DI } from '@spinajs/di';
import { InvalidOperation, InvalidOption, UnexpectedServerError } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { decryptMfaSecret, encryptMfaSecret, mfaKeyFrom } from '../mfa/cipher.js';
import type { MfaKey } from '../mfa/cipher.js';
import { checkedMs, MAX_MS, MIN_MS, sha256hex, sqlTime } from '../support/sql.js';

const NAME = 'AuthnFromUserMetadata_2026_10_02_00_01_00';
const USERS = 'users';
const META = 'users_metadata';
const MFA = 'authn_mfa';
const CODES = 'authn_recovery_code';
const SECRETS = 'authn_secret';

const STEP = 'totp';
const KEY_PATH = 'authn.mfa.encryptionKey.secret';
/** Keeps every `IN (…)` list under the bind limits of the four drivers (MSSQL: 2100). */
const CHUNK = 500;

const TOKEN = '2fa:token';
const ENABLED = '2fa:enabled';
const RESET_TOKEN = 'user:pwd_reset:token';
const RESET_START = 'user:pwd_reset:start_date';
const RESET_WAIT = 'user:pwd_reset:wait_time';
const INVITE = 'user:invite:pending';
const LEGACY_2FA = 'user:2fa:';
const PREFIXES = ['2fa:', LEGACY_2FA, 'user:login:', 'user:pwd_reset:'];
const EXACT = ['user:pwd:reset'];
const CARRIED_PURPOSES = ['reset', 'invite'];

// Matched in Node: a SQL LIKE treats `_` as a wildcard, and MySQL/MSSQL collations ignore case (D9, D11).
const isSecurityKey = (key: string): boolean => EXACT.includes(key) || PREFIXES.some((p) => key.startsWith(p));

type Row = Record<string, unknown>;

/** @internal One `users_metadata` value with its `Type` column. */
export interface LegacyMetadataValue {
  readonly type: string | undefined;
  readonly value: string | undefined;
}

/** @internal Security keys and `user:invite:pending` per `users.Id`, and the ids of the security rows to delete. */
export interface LegacyMetadata {
  readonly byUser: Map<number, Map<string, LegacyMetadataValue>>;
  readonly securityIds: number[];
  /** Non-empty `user:2fa:*` values: deleted, never carried. */
  readonly legacy2fa: number;
}

interface LegacyUserRow {
  readonly uuid: string;
  readonly email: string;
}

interface CarriedSecret {
  readonly identity: string;
  readonly uuid: string;
  readonly purpose: string;
  readonly hash: string;
  readonly startMs: number;
  readonly expiresMs: number;
}

/** What must exist after the carry, read before any write by queries the carry does not share. */
interface Census {
  readonly totp: Set<string>;
  readonly resets: Map<string, string>;
}

async function inChunks<T>(values: readonly T[], read: (chunk: T[]) => Promise<Row[]>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    rows.push(...(await read(values.slice(i, i + CHUNK))));
  }
  return rows;
}

const text = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

/**
 * The value 2.x code saw: `UniversalValueConverter.fromDB` of `@spinajs/orm` 2.x, keyed by the `Type` column.
 * `ok` is false where 2.x threw (a `json` value that does not parse).
 */
function decode2x(v: LegacyMetadataValue | undefined): { ok: boolean; value: unknown } {
  const value = v?.value;
  if (value === undefined || value === '') return { ok: true, value };
  switch (v!.type) {
    case 'boolean':
      return { ok: true, value: value === 'true' };
    case 'datetime':
    case 'date':
    case 'time':
      return { ok: true, value: DateTime.fromISO(value) };
    case 'float':
      return { ok: true, value: parseFloat(value) };
    case 'number':
      return { ok: true, value: parseInt(value, 10) };
    case 'json':
      try {
        return { ok: true, value: JSON.parse(value) };
      } catch {
        return { ok: false, value: undefined };
      }
    default:
      return { ok: true, value };
  }
}

// 2.x enforced TOTP when the decoded value was truthy. A value 2.x could not read stays confirmed: never weaker.
const isEnabled2x = (v: LegacyMetadataValue | undefined): boolean => {
  const d = decode2x(v);
  return !d.ok || Boolean(d.value);
};
// 2.x accepted a reset of an inactive account only for `=== true` (users actions, confirmPasswordReset).
const isInvite2x = (v: LegacyMetadataValue | undefined): boolean => {
  const d = decode2x(v);
  return d.ok && d.value === true;
};

/**
 * Design §22.18: moves 2.x account security state out of `users_metadata`.
 *
 * - each user with a `2fa:token` gets an `authn_mfa` `totp` row, encrypted under `authn.mfa.encryptionKey`
 *   (D8), confirmed when 2.x saw `2fa:enabled` as true; without a valid key the migration refuses before writing;
 * - each live `user:pwd_reset:token` becomes an `authn_secret` row (`invite` when 2.x saw `user:invite:pending`
 *   as `true`, else `reset`) holding its SHA-256 and its 2.x expiry; expired or malformed entries are dropped;
 * - every `2fa:*`, `user:2fa:*`, `user:login:*`, `user:pwd_reset:*` and `user:pwd:reset` key is deleted;
 *   `user:invite:pending` and every other key stay.
 *
 * Before any write a census reads the token owners on its own; after the writes every owner must have its row
 * (or, for a reset, have been dropped), and no security key may remain. Any failure throws, and the transaction
 * undoes it all. Without `users` or `users_metadata` it does nothing.
 */
@Migration('default')
export class AuthnFromUserMetadata_2026_10_02_00_01_00 extends OrmMigration {
  @Logger('authn-orm')
  protected Log: Log;

  public async up(connection: OrmDriver): Promise<void> {
    if (!(await this.hasLegacyTables(connection))) return;
    const nowMs = checkedMs(new Date(), `${NAME}: the clock`);
    const now = sqlTime(nowMs);
    const secret = await this.configuredKey(connection);

    await connection.transaction(async () => {
      const census = await this.census(connection);
      const { byUser, securityIds, legacy2fa } = await this.readMetadata(connection);
      const users = await this.usersById(connection, [...byUser.keys()]);

      const totp: { identity: string; plain: string; confirmed: boolean }[] = [];
      const resets: CarriedSecret[] = [];
      const dropped = { expired: new Set<string>(), malformed: new Set<string>() };
      let orphans = 0;
      for (const [userId, values] of byUser) {
        const user = users.get(userId);
        if (!user) {
          if ([...values.keys()].some(isSecurityKey)) orphans++;
          continue;
        }
        const identity = `user:${user.uuid}`;
        const token = values.get(TOKEN)?.value;
        if (token !== undefined && token !== '') totp.push({ identity, plain: token, confirmed: isEnabled2x(values.get(ENABLED)) });

        const reset = this.parseReset(values, nowMs);
        if (reset === 'expired' || reset === 'malformed') dropped[reset].add(identity);
        else if (reset) resets.push({ identity, uuid: user.uuid, purpose: isInvite2x(values.get(INVITE)) ? 'invite' : 'reset', ...reset });
      }
      this.refuseSharedTokens(resets);

      let key: MfaKey | undefined;
      if (totp.length > 0) {
        try {
          key = mfaKeyFrom(secret as string);
        } catch {
          throw new InvalidOption(`${NAME}: ${totp.length} user(s) have a 2fa:token to carry into authn_mfa; set ${KEY_PATH} to a 32-byte key (64 hex characters, base64 or base64url) and run the migration again`);
        }
      }
      for (const t of totp) {
        await this.insertRow(connection, MFA, { identity: t.identity, step: STEP, secret_enc: encryptMfaSecret(key!, t.identity, STEP, t.plain), key_id: key!.keyId, confirmed_at: t.confirmed ? now : null, last_step: null, created_at: now });
      }
      for (const r of resets) {
        await this.insertRow(connection, SECRETS, { id: randomUUID(), identity: r.identity, purpose: r.purpose, secret_hash: r.hash, expires_at: sqlTime(r.expiresMs), used_at: null, created_at: sqlTime(r.startMs) });
      }

      await this.verifyMfa(connection, census.totp);
      await this.verifySecrets(connection, census.resets, new Set([...dropped.expired, ...dropped.malformed]));

      await inChunks(securityIds, async (ids) => {
        await connection.del().from(META).whereIn('Id', ids);
        return [];
      });
      await this.verifyNoSecurityKeys(connection);

      const confirmed = totp.filter((t) => t.confirmed).length;
      const invites = resets.filter((r) => r.purpose === 'invite').length;
      const summary = `${NAME}: carried ${totp.length} TOTP secret(s) (${confirmed} confirmed, ${totp.length - confirmed} unconfirmed), ` + `${resets.length - invites} reset(s) and ${invites} invite(s); dropped ${dropped.expired.size} expired and ${dropped.malformed.size} malformed reset(s); ` + `deleted ${securityIds.length} users_metadata row(s), of which ${legacy2fa} non-empty user:2fa:* value(s) (not carried) and the keys of ${orphans} owner(s) missing from users`;
      if (legacy2fa > 0 || orphans > 0) this.warn(summary);
      else this.info(summary);
    });
  }

  /**
   * Decrypts each carried `totp` row back into `2fa:token` (and `2fa:enabled` when confirmed) and deletes it with
   * the identity's recovery codes. A clear reset or invite token cannot be rebuilt from its hash: those rows are
   * deleted and the users with a live one are logged, to be told to request a new link.
   */
  public async down(connection: OrmDriver): Promise<void> {
    if (!(await this.hasLegacyTables(connection))) return;
    const now = sqlTime(checkedMs(new Date(), `${NAME}: the clock`));
    const secret = await this.configuredKey(connection);

    await connection.transaction(async () => {
      const carried = ((await connection.select().from(MFA).select('identity').select('step').select('secret_enc').select('key_id').select('confirmed_at').where('step', STEP)) as Row[]).filter((r) => r.step === STEP && String(r.identity).startsWith('user:'));

      if (carried.length > 0) {
        let key: MfaKey;
        try {
          key = mfaKeyFrom(secret as string);
        } catch {
          throw new InvalidOption(`${NAME}: ${carried.length} authn_mfa totp row(s) must be decrypted back into 2fa:token; set ${KEY_PATH} to the key they were written with`);
        }
        const foreign = carried.find((r) => r.key_id !== key.keyId);
        if (foreign) {
          throw new InvalidOption(`${NAME}: authn_mfa holds secrets under key id ${String(foreign.key_id)}, but ${KEY_PATH} has key id ${key.keyId}; configure the key they were written with`);
        }
        await this.restoreTotp(connection, key, carried);
      }

      const rows = ((await connection.select().from(SECRETS).select('id').select('identity').select('purpose').whereIn('purpose', CARRIED_PURPOSES)) as Row[]).filter((r) => CARRIED_PURPOSES.includes(String(r.purpose)) && String(r.identity).startsWith('user:'));
      const ids = rows.map((r) => String(r.id));
      const live = new Set((await inChunks(ids, async (chunk) => (await connection.select().from(SECRETS).select('id').whereIn('id', chunk).whereNull('used_at').where('expires_at', '>', now)) as Row[])).map((r) => String(r.id)));
      await inChunks(ids, async (chunk) => {
        await connection.del().from(SECRETS).whereIn('id', chunk);
        return [];
      });

      const uuids = [...new Set(rows.filter((r) => live.has(String(r.id))).map((r) => String(r.identity).slice('user:'.length)))];
      if (uuids.length > 0) {
        const users = await this.usersByUuid(connection, uuids);
        const list = uuids.map((u) => (users.get(u) ? `${u} <${users.get(u)!.email}>` : u)).join(', ');
        this.warn(`${NAME}: ${uuids.length} pending password reset or invite link(s) no longer work; ask these users to request a new one: ${list}`);
      }
    });
  }

  /** @internal Every insert of `up()`, and the metadata inserts of `down()`, go through here. */
  protected async insertRow(connection: OrmDriver, table: string, values: Row): Promise<void> {
    await connection.insert().into(table).values(values);
  }

  /** @internal The users' security metadata, read for the carry. The census does not use it. */
  protected async readMetadata(connection: OrmDriver): Promise<LegacyMetadata> {
    const all = (await connection.select().from(META).select('Id').select('Key').select('user_id')) as Row[];
    const wanted = all.filter((r) => typeof r.Key === 'string' && (isSecurityKey(r.Key) || r.Key === INVITE));
    const securityIds = wanted.filter((r) => isSecurityKey(r.Key as string)).map((r) => Number(r.Id));

    const byUser = new Map<number, Map<string, LegacyMetadataValue>>();
    let legacy2fa = 0;
    const rows = await inChunks(
      wanted.map((r) => Number(r.Id)),
      async (ids) => (await connection.select().from(META).select('Id').select('Key').select('Type').select('Value').select('user_id').whereIn('Id', ids)) as Row[],
    );
    for (const r of rows) {
      const key = String(r.Key);
      if (!isSecurityKey(key) && key !== INVITE) continue;
      const value = text(r.Value);
      if (key.startsWith(LEGACY_2FA) && value) legacy2fa++;
      const userId = Number(r.user_id);
      const values = byUser.get(userId) ?? new Map<string, LegacyMetadataValue>();
      if (!values.has(key)) values.set(key, { type: text(r.Type), value });
      byUser.set(userId, values);
    }
    return { byUser, securityIds, legacy2fa };
  }

  protected warn(message: string): void {
    this.Log.warn(message);
  }

  protected info(message: string): void {
    this.Log.info(message);
  }

  private async hasLegacyTables(connection: OrmDriver): Promise<boolean> {
    const missing: string[] = [];
    for (const table of [USERS, META]) {
      if (!(await connection.schema().tableExists(table))) missing.push(table);
    }
    if (missing.length === 0) return true;
    this.info(`${NAME}: no ${missing.join(' or ')} table, nothing to carry`);
    return false;
  }

  /** The Orm resolves migrations in the connection's container, which sees the app's (or a test's) configuration. */
  private async configuredKey(connection: OrmDriver): Promise<unknown> {
    const container = connection.Container ?? DI.RootContainer;
    const config = container.get(Configuration) ?? (await container.resolve(Configuration));
    return config.get<unknown>(KEY_PATH, undefined);
  }

  /** Owners of a non-empty `2fa:token`, and of a non-empty reset token with its hash, by their own queries. */
  private async census(connection: OrmDriver): Promise<Census> {
    const rows = ((await connection.select().from(META).select('user_id').select('Key').select('Value').whereIn('Key', [TOKEN, RESET_TOKEN])) as Row[]).filter((r) => (r.Key === TOKEN || r.Key === RESET_TOKEN) && typeof r.Value === 'string' && r.Value !== '');
    const owners = await inChunks([...new Set(rows.map((r) => Number(r.user_id)))], async (ids) => (await connection.select().from(USERS).select('Id').select('Uuid').whereIn('Id', ids)) as Row[]);
    const uuidOf = new Map(owners.map((o) => [Number(o.Id), String(o.Uuid)]));

    const census: Census = { totp: new Set(), resets: new Map() };
    for (const r of rows) {
      const uuid = uuidOf.get(Number(r.user_id));
      if (uuid === undefined) continue;
      if (r.Key === TOKEN) census.totp.add(`user:${uuid}`);
      else census.resets.set(`user:${uuid}`, sha256hex(r.Value as string));
    }
    return census;
  }

  private async usersById(connection: OrmDriver, ids: number[]): Promise<Map<number, LegacyUserRow>> {
    const rows = await inChunks(ids, async (chunk) => (await connection.select().from(USERS).select('Id').select('Uuid').select('Email').whereIn('Id', chunk)) as Row[]);
    return new Map(rows.map((r) => [Number(r.Id), { uuid: String(r.Uuid), email: String(r.Email) }]));
  }

  private async usersByUuid(connection: OrmDriver, uuids: string[]): Promise<Map<string, LegacyUserRow & { id: number }>> {
    const rows = await inChunks(uuids, async (chunk) => (await connection.select().from(USERS).select('Id').select('Uuid').select('Email').whereIn('Uuid', chunk)) as Row[]);
    const wanted = new Set(uuids);
    return new Map(rows.filter((r) => wanted.has(String(r.Uuid))).map((r) => [String(r.Uuid), { id: Number(r.Id), uuid: String(r.Uuid), email: String(r.Email) }]));
  }

  /**
   * A reset that is still live at `nowMs`; `expired`, or `malformed` (no or bad start or wait); undefined without a
   * token. A start date without an offset is read as UTC: 2.x always wrote one, so its server's zone is unknown.
   */
  private parseReset(values: Map<string, LegacyMetadataValue>, nowMs: number): Pick<CarriedSecret, 'hash' | 'startMs' | 'expiresMs'> | 'expired' | 'malformed' | undefined {
    const token = values.get(RESET_TOKEN)?.value;
    if (!token) return undefined;
    const start = values.get(RESET_START)?.value;
    const wait = values.get(RESET_WAIT)?.value;
    if (start === undefined || wait === undefined || !/^\d{1,10}$/.test(wait)) return 'malformed';

    const startAt = DateTime.fromISO(start, { zone: 'utc', setZone: true });
    if (!startAt.isValid) return 'malformed';
    const startMs = startAt.toMillis();
    const expiresMs = startMs + Number(wait) * 1000;
    if (startMs < MIN_MS || expiresMs > MAX_MS) return 'malformed';
    if (expiresMs <= nowMs) return 'expired';
    return { hash: sha256hex(token), startMs, expiresMs };
  }

  /** Two users with one token cannot both be carried (unique hash), and such a token is no proof of either. */
  private refuseSharedTokens(resets: readonly CarriedSecret[]): void {
    const byHash = new Map<string, string[]>();
    for (const r of resets) byHash.set(r.hash, [...(byHash.get(r.hash) ?? []), r.uuid]);
    const shared = [...byHash.values()].filter((uuids) => uuids.length > 1).flat();
    if (shared.length > 0) {
      throw new InvalidOperation(`${NAME}: users ${shared.join(', ')} share one pending password reset token; delete their user:pwd_reset:* keys and run the migration again`);
    }
  }

  private async verifyMfa(connection: OrmDriver, owners: Set<string>): Promise<void> {
    const rows = await inChunks([...owners], async (chunk) => (await connection.select().from(MFA).select('identity').select('step').where('step', STEP).whereIn('identity', chunk)) as Row[]);
    const found = new Set(rows.filter((r) => r.step === STEP && owners.has(String(r.identity))).map((r) => String(r.identity)));
    const missing = [...owners].filter((o) => !found.has(o));
    if (missing.length > 0) {
      throw new UnexpectedServerError(`${NAME}: count check failed: ${owners.size} users had a 2fa:token, but ${missing.length} of them have no authn_mfa totp row (${missing.join(', ')}); nothing was changed`);
    }
  }

  /** Each reset owner of the census must now hold its exact row, or have been dropped, never both. */
  private async verifySecrets(connection: OrmDriver, owners: Map<string, string>, dropped: Set<string>): Promise<void> {
    const rows = await inChunks([...owners.values()], async (chunk) => (await connection.select().from(SECRETS).select('identity').select('purpose').select('secret_hash').whereIn('secret_hash', chunk)) as Row[]);
    const carried = new Set([...owners].filter(([identity, hash]) => rows.some((r) => r.identity === identity && r.secret_hash === hash && CARRIED_PURPOSES.includes(String(r.purpose)))).map(([identity]) => identity));
    const wrong = [...owners.keys()].filter((o) => carried.has(o) === dropped.has(o));
    const stray = [...dropped].filter((d) => !owners.has(d));
    if (wrong.length > 0 || stray.length > 0) {
      throw new UnexpectedServerError(`${NAME}: count check failed: ${owners.size} users had a reset token, ${carried.size} were carried and ${dropped.size} dropped (${[...wrong, ...stray].join(', ')}); nothing was changed`);
    }
  }

  private async verifyNoSecurityKeys(connection: OrmDriver): Promise<void> {
    const left = ((await connection.select().from(META).select('Id').select('Key')) as Row[]).filter((r) => typeof r.Key === 'string' && isSecurityKey(r.Key)).length;
    if (left > 0) {
      throw new UnexpectedServerError(`${NAME}: ${left} security key(s) are still in users_metadata after the delete, probably written by a 2.x instance meanwhile; stop every 2.x instance and run the migration again`);
    }
  }

  private async restoreTotp(connection: OrmDriver, key: MfaKey, carried: Row[]): Promise<void> {
    // Decrypt everything first, so a bad row throws before anything is written.
    const plain = carried.map((r) => ({ identity: String(r.identity), confirmed: r.confirmed_at !== null && r.confirmed_at !== undefined, secret: decryptMfaSecret(key, String(r.identity), STEP, String(r.secret_enc)) }));
    const users = await this.usersByUuid(
      connection,
      plain.map((p) => p.identity.slice('user:'.length)),
    );

    const missing: string[] = [];
    for (const p of plain) {
      const user = users.get(p.identity.slice('user:'.length));
      if (!user) {
        missing.push(p.identity);
        continue;
      }
      const existing = ((await connection.select().from(META).select('Id').select('Key').where('user_id', user.id)) as Row[]).filter((r) => r.Key === TOKEN || r.Key === ENABLED);
      if (existing.length > 0) {
        await connection
          .del()
          .from(META)
          .whereIn(
            'Id',
            existing.map((r) => Number(r.Id)),
          );
      }
      try {
        await this.insertRow(connection, META, { Key: TOKEN, Type: 'string', Value: p.secret, user_id: user.id });
      } catch {
        // The driver error keeps the statement's bindings, the clear secret among them.
        throw new UnexpectedServerError(`${NAME}: could not restore 2fa:token for user ${user.uuid}`);
      }
      if (p.confirmed) await this.insertRow(connection, META, { Key: ENABLED, Type: 'boolean', Value: 'true', user_id: user.id });
    }

    for (const p of plain) {
      await connection.del().from(MFA).where('identity', p.identity).where('step', STEP);
    }
    const identities = plain.map((p) => p.identity);
    const wanted = new Set(identities);
    const codes = (await inChunks(identities, async (chunk) => (await connection.select().from(CODES).select('id').select('identity').whereIn('identity', chunk)) as Row[])).filter((r) => wanted.has(String(r.identity)));
    await inChunks(
      codes.map((r) => String(r.id)),
      async (chunk) => {
        await connection.del().from(CODES).whereIn('id', chunk);
        return [];
      },
    );

    if (missing.length > 0) this.warn(`${NAME}: dropped the TOTP secrets of ${missing.length} identities with no row in users: ${missing.join(', ')}`);
  }
}
