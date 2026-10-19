import { AuthzAdminFailure, AuthzConfigError, principalKey } from '@spinajs/authz';
import type { AuthzTx, LinkDef, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { CONFIGURATION_CONTAINER_KEY, Config } from '@spinajs/configuration';
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { DateTime } from 'luxon';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { AdminLinkStore } from '../admin/ports.js';
import { parsePrincipalKey, scopeFromColumns, scopeToColumns } from './columns.js';
import { requireTransaction } from './context.js';
import { DbAssignmentStore } from './db-assignment-store.js';
import { withDbRbacStore } from './db-store.js';
import { pageWindow, requireScopeNode } from './queries.js';
import { LinkRecord, fromDateTime, recordValues, toDateTime } from './records.js';
import type { LinkFields } from './records.js';
import { LINK_SECRET_MIN_LENGTH } from './schema.js';
import { normaliseTags } from './tags.js';
import { bumpVersion } from './version.js';

/** Config key of the HMAC secret for link tokens: a string of at least 32 characters, no default. */
export const LINK_SECRET_KEY = 'authz.rbac.links.secret';

/** The most links one `find` call returns, with or without a page. */
export const LINK_LIST_MAX_LIMIT = 1000;

const TOKEN_BYTES = 32;
// `token_hash` is `v1:<hex HMAC-SHA256(secret, token)>`; the prefix names the key so a rotation can add v2.
const HASH_VERSION = 'v1';

/** The longest string `byToken` looks up; anything longer, or empty, is unknown without a query. */
export const LINK_TOKEN_MAX_LENGTH = 512;

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
export class DbLinkStore extends withDbRbacStore(AdminLinkStore) {
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
    const [row] = await LinkRecord.query().where('token_hash', hash).whereNull('revoked_at');

    return row && this.hashesEqual(row.token_hash, hash) ? rowToLink(row) : null;
  }

  /** The live or expired link; null when unknown or revoked. */
  async byId(id: string): Promise<LinkDef | null> {
    if (typeof id !== 'string') return null;
    const row = await this.liveRow(id);
    return row ? rowToLink(row) : null;
  }

  /** Writes the link and its assignment (`grant` at `l.scope`, expiring with the link); returns the token once. */
  async create(l: Omit<LinkDef, 'id'>, grant: { role: string; tags?: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<{ link: LinkDef; token: string }> {
    const where = `${this.name}.create`;
    requireTransaction(LinkRecord, tx, where);
    const secret = await this.secret();
    requireScopeNode(l.scope, where, 'a link needs a scope node');
    const attributes = plainAttributes(l.attributes, where);
    normaliseTags(grant.tags);

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const row: LinkFields = { id: randomUUID(), token_hash: linkTokenHash(secret, token), ...scopeToColumns(l.scope), attributes, expires_at: toDateTime(l.expiresAt), revoked_at: null, created_by: principalKey(actor), created_at: toDateTime(this.now()) };
    await LinkRecord.insert(recordValues<LinkRecord>(row));

    await this.assignments().assign({ subject: linkSubject(row.id), role: grant.role, scope: l.scope, ...(grant.tags ? { tags: grant.tags } : {}), expiresAt: l.expiresAt ?? null }, actor, tx);

    return { link: rowToLink(row), token };
  }

  /** Marks the link revoked (the row stays) and deletes its assignments; unknown or revoked id ⇒ `not_found`. */
  async revoke(id: string, _actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    requireTransaction(LinkRecord, tx, `${this.name}.revoke`);
    const { RowsAffected } = await LinkRecord.update(recordValues<LinkRecord>({ revoked_at: toDateTime(this.now()) }))
      .where('id', id)
      .whereNull('revoked_at');
    if (RowsAffected === 0) throw notFound(id);

    await this.assignments().revokeSubjects([linkSubject(id)], tx);
  }

  /** `link.update`: replaces the expiry (of the link and its assignments) and the attributes given; unknown or revoked id ⇒ `not_found`. */
  async update(id: string, patch: LinkPatch, _actor: PrincipalRef, tx: AuthzTx): Promise<LinkDef> {
    const where = `${this.name}.update`;
    requireTransaction(LinkRecord, tx, where);
    const change: { attributes?: Readonly<Record<string, unknown>>; expires_at?: DateTime | null } = {};
    if (patch.attributes !== undefined) change.attributes = plainAttributes(patch.attributes, where);
    if (patch.expiresAt !== undefined) change.expires_at = toDateTime(patch.expiresAt);

    const row = await this.liveRow(id);
    if (!row) throw notFound(id);

    if (Object.keys(change).length > 0) {
      const { RowsAffected } = await LinkRecord.update(recordValues<LinkRecord>(change)).where('id', id).whereNull('revoked_at');
      if (RowsAffected === 0) throw notFound(id);
    }

    let assignmentWrites = 0;
    if (patch.expiresAt !== undefined) {
      const assignments = this.assignments();
      const { items } = await assignments.find({ subject: linkSubject(id), includeExpired: true, at: this.now() });
      for (const a of items) await assignments.setExpiry(a.id, patch.expiresAt, tx);
      assignmentWrites = items.length;
    }
    if (assignmentWrites === 0) await bumpVersion(tx, this.domain(), where);

    return rowToLink({ ...row, ...change });
  }

  /**
   * `scope.forget`: revokes the links AT `scope` (not below it), expired ones too, and deletes their
   * assignments; returns them. GLOBAL and type-level refs are refused (`wrong_scope_type`).
   */
  async forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly LinkDef[]> {
    const where = `${this.name}.forgetScope`;
    requireScopeNode(scope, where, 'only a scope node can be forgotten');
    requireTransaction(LinkRecord, tx, where);

    const rows = await this.liveRowsAt(scope);
    if (rows.length > 0) {
      await LinkRecord.update(recordValues<LinkRecord>({ revoked_at: toDateTime(this.now()) }))
        .whereIn(
          'id',
          rows.map((r) => r.id),
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

    const filtered = () => {
      const query = LinkRecord.query().whereNull('revoked_at');
      if (q.scope) query.where(scopeToColumns(q.scope));
      return query;
    };

    if (!window) {
      const items = (await filtered().orderBy('created_at').orderBy('id')).map(rowToLink);
      return { items, total: items.length };
    }

    const total = await filtered().selectCount();
    if (window.limit === 0) return { items: [], total };

    const query = filtered().orderBy('created_at').orderBy('id').take(window.limit);
    if (window.offset > 0) query.skip(window.offset);

    return { items: (await query).map(rowToLink), total };
  }

  protected assignments(): DbAssignmentStore {
    return this.container.resolve(DbAssignmentStore);
  }

  protected async liveRow(id: string): Promise<LinkRecord | undefined> {
    const [row] = await LinkRecord.query().where('id', id).whereNull('revoked_at');
    return row;
  }

  protected async liveRowsAt(scope: ResourceRef): Promise<LinkRecord[]> {
    return LinkRecord.query().where(scopeToColumns(scope)).whereNull('revoked_at');
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
    if (typeof secret !== 'string' || secret.length < LINK_SECRET_MIN_LENGTH) {
      throw new AuthzConfigError(`${LINK_SECRET_KEY} must be set to hash share link tokens: a string of at least ${LINK_SECRET_MIN_LENGTH} characters`);
    }

    return secret;
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

function linkSubject(id: string): PrincipalRef {
  return { type: 'link', id };
}

/** A plain object that serialises to JSON; anything else is `invalid_attributes`, before a write. */
function plainAttributes(attributes: unknown, where: string): Readonly<Record<string, unknown>> {
  const proto = attributes !== null && typeof attributes === 'object' ? Object.getPrototypeOf(attributes) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new AuthzAdminFailure('invalid_attributes', `${where}: attributes must be a plain object`, 'attributes');
  }
  try {
    JSON.stringify(attributes);
  } catch (err) {
    throw new AuthzAdminFailure('invalid_attributes', `${where}: attributes must be JSON (${(err as Error).message})`, 'attributes', { cause: err });
  }
  return attributes as Readonly<Record<string, unknown>>;
}

function rowToLink(row: LinkFields): LinkDef {
  const createdBy = parsePrincipalKey(row.created_by);

  return {
    id: row.id,
    scope: scopeFromColumns(row.scope_type, row.scope_id),
    expiresAt: fromDateTime(row.expires_at),
    attributes: row.attributes ?? {},
    ...(createdBy ? { createdBy } : {}),
  };
}

function notFound(id: string): AuthzAdminFailure {
  return new AuthzAdminFailure('not_found', `Link ${JSON.stringify(id)} does not exist or is revoked`, 'id');
}
