import { AuthzAdminFailure, AuthzClock, AuthzConfigError, GLOBAL, principalKey } from '@spinajs/authz';
import type { AuthzTx, LinkDef, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { CONFIGURATION_CONTAINER_KEY, Config } from '@spinajs/configuration';
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { AdminLinkStore } from '../admin/ports.js';
import { parsePrincipalKey, scopeFromColumns, scopeToColumns, toDate } from './columns.js';
import { storeConnection, storeDomain, storeTransactionDriver } from './context.js';
import { DbAssignmentStore } from './db-assignment-store.js';
import { pageWindow } from './queries.js';
import { normaliseTags } from './tags.js';
import { bumpVersion } from './version.js';

export const AUTHZ_LINK_TABLE = 'authz_link';

/** Config key of the HMAC secret for link tokens: a string of at least 32 characters, no default. */
export const LINK_SECRET_KEY = 'authz.rbac.links.secret';

/** The most links one `find` call returns, with or without a page. */
export const LINK_LIST_MAX_LIMIT = 1000;

const MIN_SECRET_LENGTH = 32;
const TOKEN_BYTES = 32;
// `token_hash` is `v1:<hex HMAC-SHA256(secret, token)>`; the prefix names the key so a rotation can add v2.
const HASH_VERSION = 'v1';

/** The longest string `byToken` looks up; anything longer, or empty, is unknown without a query. */
export const LINK_TOKEN_MAX_LENGTH = 512;
const ID_BATCH = 500;

/** One `authz_link` row as the drivers return it (datetimes are text on SQLite). */
export interface LinkRow {
  id: string;
  token_hash: string;
  scope_type: string;
  scope_id: string;
  attributes: string | null;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
}

/** `link.update` without role and tags (those change the link's assignment). */
export interface LinkPatch {
  readonly expiresAt?: Date | null;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface LinkQuery {
  readonly scope?: ResourceRef;
}

/**
 * `LinkStore` over `authz_link` (design §6.1.6, §9.1). A link's grant is an ordinary assignment to
 * subject `link:<id>`, written through {@link DbAssignmentStore} in the same transaction. The token
 * exists only in `create`'s result; the row keeps its keyed hash.
 *
 * Version bumps: each write call bumps `authz_version` at least once in its transaction. The link
 * store bumps itself only when it makes no assignment write, so `create`, `revoke`, `forgetScope`
 * and an `update` without `expiresAt` bump exactly once; an `update` of `expiresAt` bumps once per
 * assignment of the link (once, unless L9 granted the link more).
 *
 * Registered by class name only; a domain uses it by registering it as `AdminLinkStore` and `LinkStore`.
 */
@PerChildInstance()
@Injectable()
@Inject(Container)
export class DbLinkStore extends AdminLinkStore {
  readonly name: string = 'DbLinkStore';

  protected readonly maxListLimit: number = LINK_LIST_MAX_LIMIT;

  // Optional here: only a domain that uses DbLinkStore needs a secret, which only DI knows; the schema checks its length.
  @Config(LINK_SECRET_KEY)
  protected Secret: string | undefined;

  constructor(protected readonly container: IContainer) {
    super();
    // Built with `new`, the store reads the Configuration of the container it is given, as when DI builds it there.
    (this as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = container;
  }

  /**
   * The live or expired link of `token`; null when unknown or revoked (no query when the token is
   * empty or longer than {@link LINK_TOKEN_MAX_LENGTH}). An expired link is returned with its `expiresAt`: the link principal's ceiling denies it at the
   * engine's clock, which the store does not know.
   */
  async byToken(token: string): Promise<LinkDef | null> {
    const secret = await this.secret();
    if (!isLookupToken(token)) return null;

    const hash = linkTokenHash(secret, token);
    const [row] = await rowsOf((await this.connection()).select().from(AUTHZ_LINK_TABLE).where('token_hash', hash).whereNull('revoked_at'));

    return row && this.hashesEqual(row.token_hash, hash) ? rowToLink(row) : null;
  }

  /** The live or expired link; null when unknown or revoked. */
  async byId(id: string): Promise<LinkDef | null> {
    if (typeof id !== 'string') return null;
    const row = await this.liveRow(await this.connection(), id);
    return row ? rowToLink(row) : null;
  }

  /** Writes the link and its assignment (`grant` at `l.scope`, expiring with the link); returns the token once. */
  async create(l: Omit<LinkDef, 'id'>, grant: { role: string; tags?: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<{ link: LinkDef; token: string }> {
    const driver = await this.writeDriver(tx, `${this.name}.create`);
    const secret = await this.secret();
    requireScopeNode(l.scope, `${this.name}.create`, 'a link needs a scope node');
    const attributes = attributesText(l.attributes, `${this.name}.create`);
    normaliseTags(grant.tags);

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const row: LinkRow = { id: randomUUID(), token_hash: linkTokenHash(secret, token), ...scopeToColumns(l.scope), attributes, expires_at: l.expiresAt ?? null, revoked_at: null, created_by: principalKey(actor), created_at: this.now() };
    await driver.insert().into(AUTHZ_LINK_TABLE).values(row);

    await this.assignments().assign({ subject: { type: 'link', id: row.id }, role: grant.role, scope: l.scope, ...(grant.tags ? { tags: grant.tags } : {}), expiresAt: row.expires_at as Date | null }, actor, tx);

    return { link: rowToLink(row), token };
  }

  /** Marks the link revoked (the row stays) and deletes its assignments; unknown or revoked id ⇒ `not_found`. */
  async revoke(id: string, _actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    const driver = await this.writeDriver(tx, `${this.name}.revoke`);
    const result = await driver.update().in(AUTHZ_LINK_TABLE).update({ revoked_at: this.now() }).where('id', id).whereNull('revoked_at');
    if (rowsAffected(result) === 0) throw notFound(id);

    await this.assignments().revokeSubjects([linkSubject(id)], tx);
  }

  /** `link.update`: replaces the expiry (of the link and its assignments) and the attributes given; unknown or revoked id ⇒ `not_found`. */
  async update(id: string, patch: LinkPatch, _actor: PrincipalRef, tx: AuthzTx): Promise<LinkDef> {
    const driver = await this.writeDriver(tx, `${this.name}.update`);
    const change: Partial<LinkRow> = {};
    if (patch.attributes !== undefined) change.attributes = attributesText(patch.attributes, `${this.name}.update`);
    if (patch.expiresAt !== undefined) change.expires_at = patch.expiresAt;

    const row = await this.liveRow(driver, id);
    if (!row) throw notFound(id);

    if (Object.keys(change).length > 0) {
      const result = await driver.update().in(AUTHZ_LINK_TABLE).update(change).where('id', id).whereNull('revoked_at');
      if (rowsAffected(result) === 0) throw notFound(id);
    }

    let assignmentWrites = 0;
    if (patch.expiresAt !== undefined) {
      const assignments = this.assignments();
      const { items } = await assignments.find({ subject: linkSubject(id), includeExpired: true, at: this.now() });
      for (const a of items) await assignments.setExpiry(a.id, patch.expiresAt, tx);
      assignmentWrites = items.length;
    }
    if (assignmentWrites === 0) await bumpVersion(driver, this.domain());

    return rowToLink({ ...row, ...change });
  }

  /**
   * `scope.forget`: revokes the links AT `scope` (not below it), expired ones too, and deletes their
   * assignments; returns them. GLOBAL and type-level refs are refused (`wrong_scope_type`).
   */
  async forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly LinkDef[]> {
    requireScopeNode(scope, `${this.name}.forgetScope`, 'only a scope node can be forgotten');

    const driver = await this.writeDriver(tx, `${this.name}.forgetScope`);
    const rows = await this.liveRowsAt(driver, scope);
    const revokedAt = this.now();

    for (let i = 0; i < rows.length; i += ID_BATCH) {
      await driver
        .update()
        .in(AUTHZ_LINK_TABLE)
        .update({ revoked_at: revokedAt })
        .whereIn(
          'id',
          rows.slice(i, i + ID_BATCH).map((r) => r.id),
        )
        .whereNull('revoked_at');
    }

    await this.assignments().revokeSubjects(
      rows.map((r) => linkSubject(r.id)),
      tx,
    );
    return rows.map(rowToLink);
  }

  /**
   * Links that are not revoked (expired ones included) for `AuthzAdmin.list` (kind `links`), oldest
   * first; `total` counts the unpaged result. Without a page, every match in one query; with one, at
   * most {@link LINK_LIST_MAX_LIMIT} rows. A negative or fractional `limit` or `offset` is
   * `invalid_page`.
   */
  async find(q: LinkQuery, page?: { limit: number; offset: number }): Promise<{ items: readonly LinkDef[]; total: number }> {
    const window = page ? pageWindow(page, this.maxListLimit, `${this.name}.find`) : undefined;

    const driver = await this.connection();
    const filtered = () => {
      const query = driver.select().from(AUTHZ_LINK_TABLE).whereNull('revoked_at');
      if (q.scope) query.where(scopeToColumns(q.scope));
      return query;
    };

    if (!window) {
      const items = (await rowsOf(filtered().orderBy('created_at').orderBy('id'))).map(rowToLink);
      return { items, total: items.length };
    }

    const total = Number(await filtered().selectCount());
    if (window.limit === 0) return { items: [], total };

    const query = filtered().orderBy('created_at').orderBy('id').take(window.limit);
    if (window.offset > 0) query.skip(window.offset);

    return { items: (await rowsOf(query)).map(rowToLink), total };
  }

  protected connection(): Promise<OrmDriver> {
    return storeConnection(this.container);
  }

  /** The driver of `tx`, which must be a transaction on {@link connection}. */
  protected async writeDriver(tx: AuthzTx, where: string): Promise<OrmDriver> {
    return storeTransactionDriver(tx, await this.connection(), where);
  }

  protected assignments(): DbAssignmentStore {
    return this.container.resolve(DbAssignmentStore);
  }

  protected async liveRow(driver: OrmDriver, id: string): Promise<LinkRow | undefined> {
    const [row] = await rowsOf(driver.select().from(AUTHZ_LINK_TABLE).where('id', id).whereNull('revoked_at'));
    return row;
  }

  protected liveRowsAt(driver: OrmDriver, scope: ResourceRef): Promise<LinkRow[]> {
    return rowsOf(driver.select().from(AUTHZ_LINK_TABLE).where(scopeToColumns(scope)).whereNull('revoked_at'));
  }

  /** Defence in depth: the row was found by this hash; the keyed hash is what makes the indexed lookup timing-safe. */
  protected hashesEqual(stored: string, computed: string): boolean {
    const a = Buffer.from(stored, 'utf8');
    const b = Buffer.from(computed, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Read on every use, so the store can be resolved before the secret is configured. */
  protected async secret(): Promise<string> {
    const secret = this.Secret;

    // Floor for a secret that bypassed the schema (a runtime set): a weak key would let links be forged.
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
      throw new AuthzConfigError(`${LINK_SECRET_KEY} must be set to hash share link tokens: a string of at least ${MIN_SECRET_LENGTH} characters`);
    }

    return secret;
  }

  protected domain(): string {
    return storeDomain(this.container);
  }

  protected now(): Date {
    return this.container.hasRegistered(AuthzClock) ? this.container.resolve(AuthzClock).now() : new Date();
  }
}

/** Any string of 1 to {@link LINK_TOKEN_MAX_LENGTH} characters; only the hash decides whether it is a link. */
function isLookupToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.length <= LINK_TOKEN_MAX_LENGTH;
}

/** The `token_hash` column of a link whose token is `token` (seed rows with it, never store the token). */
export function linkTokenHash(secret: string, token: string): string {
  return `${HASH_VERSION}:${createHmac('sha256', secret).update(token, 'utf8').digest('hex')}`;
}

function requireScopeNode(scope: ResourceRef, where: string, rule: string): void {
  if (scope?.type === GLOBAL.type || !scope?.id) {
    throw new AuthzAdminFailure('wrong_scope_type', `${where}: ${rule}, not ${scope?.type === GLOBAL.type ? 'GLOBAL' : `the type-level ref ${scope?.type}`}`, 'scope');
  }
}

function linkSubject(id: string): PrincipalRef {
  return { type: 'link', id };
}

function attributesText(attributes: unknown, where: string): string {
  const proto = attributes !== null && typeof attributes === 'object' ? Object.getPrototypeOf(attributes) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new AuthzAdminFailure('invalid_attributes', `${where}: attributes must be a plain object`, 'attributes');
  }
  try {
    return JSON.stringify(attributes);
  } catch (err) {
    throw new AuthzAdminFailure('invalid_attributes', `${where}: attributes must be JSON (${(err as Error).message})`, 'attributes', { cause: err });
  }
}

function rowToLink(row: LinkRow): LinkDef {
  const createdBy = parsePrincipalKey(row.created_by);
  let attributes: Record<string, unknown>;

  try {
    attributes = row.attributes ? (JSON.parse(row.attributes) as Record<string, unknown>) : {};
  } catch (err) {
    throw new AuthzConfigError(`${AUTHZ_LINK_TABLE} ${row.id}: unreadable attributes`, { cause: err });
  }

  return {
    id: row.id,
    scope: scopeFromColumns(row.scope_type, row.scope_id),
    expiresAt: toDate(row.expires_at),
    attributes,
    ...(createdBy ? { createdBy } : {}),
  };
}

function notFound(id: string): AuthzAdminFailure {
  return new AuthzAdminFailure('not_found', `Link ${JSON.stringify(id)} does not exist or is revoked`, 'id');
}

async function rowsOf(query: PromiseLike<unknown>): Promise<LinkRow[]> {
  return (await query) as LinkRow[];
}

function rowsAffected(result: unknown): number {
  return Number((result as { RowsAffected?: unknown } | undefined)?.RowsAffected ?? 0);
}
