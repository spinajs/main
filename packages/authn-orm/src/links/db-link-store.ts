import { randomUUID } from 'node:crypto';

import { IdentityLinkStore } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityLink, IdentityRef } from '@spinajs/authn/contracts';
import { Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { OrmDriver } from '@spinajs/orm';

import { StoreConnection } from '../support/connection.js';
import type { StoreOptions } from '../support/connection.js';
import { checkedMs, checkedText, columnText, isDuplicate, rowsAffected, selectTime, sqlTime, textMs } from '../support/sql.js';
import type { Dialect } from '../support/sql.js';

const TABLE = 'authn_identity';

function identityParts(ref: IdentityRef): { type: string; id: string } {
  const type = checkedText(ref?.type, 16, 'DbIdentityLinkStore: identity type');
  if (type.includes(':')) throw new InvalidArgument(`DbIdentityLinkStore: identity type "${type}" contains ":"`);
  return { type, id: checkedText(ref.id, 64, 'DbIdentityLinkStore: identity id') };
}

/** `authn_identity`: external subjects linked to identities (A19). Values longer than their columns throw (D1). */
@Singleton()
@Injectable(IdentityLinkStore)
export class DbIdentityLinkStore extends IdentityLinkStore {
  private readonly connection: StoreConnection;

  /** DI passes nothing: the Orm's `'default'` connection is resolved on first use. */
  constructor(driver?: OrmDriver, options: StoreOptions = {}) {
    super();
    this.connection = new StoreConnection('DbIdentityLinkStore', driver, options.container);
  }

  public async find(provider: string, subject: string): Promise<IdentityLink | null> {
    const { driver, dialect } = await this.connection.get();
    const rows = (await this.selectLinks(driver, dialect).where('provider', provider).where('subject', subject)) as Record<string, unknown>[];
    // MySQL and MSSQL default collations ignore case (and accents or trailing spaces): a subject differing only that
    // way must not sign in as another account.
    const exact = rows.find((r) => r.provider === provider && r.subject === subject);
    return exact ? this.toLink(dialect, exact) : null;
  }

  public async list(identity: IdentityRef): Promise<readonly IdentityLink[]> {
    const { type, id } = identityParts(identity);
    const { driver, dialect } = await this.connection.get();
    const rows = (await this.selectLinks(driver, dialect).where('identity_type', type).where('identity_id', id).orderBy('linked_at')) as Record<string, unknown>[];
    return rows.map((r) => this.toLink(dialect, r));
  }

  /** A duplicate (provider, subject) rejects with `ResourceDuplicated` (the unique index decides). */
  public async link(identity: IdentityRef, external: ExternalSubject): Promise<IdentityLink> {
    const { type, id } = identityParts(identity);
    const provider = checkedText(external?.provider, 128, 'DbIdentityLinkStore: provider');
    const subject = checkedText(external.subject, 255, 'DbIdentityLinkStore: subject');
    const email = external.email === undefined || external.email === null ? undefined : checkedText(external.email, 255, 'DbIdentityLinkStore: email', true);
    const nowMs = checkedMs(new Date(), 'DbIdentityLinkStore.link: the clock');
    const { driver } = await this.connection.get();

    const linkId = randomUUID();
    try {
      await driver
        .insert()
        .into(TABLE)
        .values({ id: linkId, identity_type: type, identity_id: id, provider, subject, email: email ?? null, email_verified: external.emailVerified === true, attributes: null, linked_at: sqlTime(nowMs), last_used_at: null });
    } catch (err) {
      if (isDuplicate(err)) throw new ResourceDuplicated(`DbIdentityLinkStore: (${provider}, subject) is already linked`, err);
      throw err;
    }
    return { id: linkId, identity: { type, id }, provider, subject, ...(email !== undefined ? { email } : {}), linkedAt: new Date(nowMs) };
  }

  public async unlink(id: string): Promise<void> {
    const { driver } = await this.connection.get();
    await driver.del().from(TABLE).where('id', id);
  }

  /** Sets `last_used_at` (default now); true when the link exists. */
  public async touch(id: string, at: Date = new Date()): Promise<boolean> {
    const t = sqlTime(checkedMs(at, 'DbIdentityLinkStore.touch: at'));
    const { driver } = await this.connection.get();
    return rowsAffected(await driver.update().in(TABLE).update({ last_used_at: t }).where('id', id)) === 1;
  }

  private selectLinks(driver: OrmDriver, dialect: Dialect) {
    const q = driver.select().from(TABLE).select('id').select('identity_type').select('identity_id').select('provider').select('subject').select('email');
    return selectTime(dialect, selectTime(dialect, q, 'linked_at', 'linked_text'), 'last_used_at', 'last_used_text');
  }

  private toLink(dialect: Dialect, r: Record<string, unknown>): IdentityLink {
    const lastUsed = columnText(dialect, r, 'last_used_at', 'last_used_text');
    return {
      id: String(r.id),
      identity: { type: String(r.identity_type), id: String(r.identity_id) },
      provider: String(r.provider),
      subject: String(r.subject),
      ...(r.email !== null && r.email !== undefined ? { email: String(r.email) } : {}),
      linkedAt: new Date(textMs(columnText(dialect, r, 'linked_at', 'linked_text') ?? '')),
      ...(lastUsed !== null ? { lastUsedAt: new Date(textMs(lastUsed)) } : {}),
    };
  }
}
