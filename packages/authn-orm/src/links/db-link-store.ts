import { randomUUID } from 'node:crypto';

import { IdentityLinkStore } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityLink, IdentityRef } from '@spinajs/authn/contracts';
import { Autoinject, Injectable, PerChildInstance } from '@spinajs/di';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { Orm, UniqueViolation } from '@spinajs/orm';

import { AuthnIdentity } from '../models/AuthnIdentity.js';
import { checkedMs, checkedText, dateOf, instant } from '../support/sql.js';
import { columnValues } from '../support/values.js';

const LINK_COLUMNS = ['id', 'identity_type', 'identity_id', 'provider', 'subject', 'email', 'linked_at', 'last_used_at'];

function identityParts(ref: IdentityRef): { type: string; id: string } {
  const type = checkedText(ref?.type, 16, 'DbIdentityLinkStore: identity type');
  if (type.includes(':')) throw new InvalidArgument(`DbIdentityLinkStore: identity type "${type}" contains ":"`);
  return { type, id: checkedText(ref.id, 64, 'DbIdentityLinkStore: identity id') };
}

/** `authn_identity`: external subjects linked to identities (A19). Values longer than their columns throw (D1). */
@PerChildInstance()
@Injectable(IdentityLinkStore)
export class DbIdentityLinkStore extends IdentityLinkStore {
  /** Never read: injecting it resolves the Orm, which binds the models, before the first query. */
  @Autoinject(Orm)
  protected Orm: Orm;

  public async find(provider: string, subject: string): Promise<IdentityLink | null> {
    const rows = await AuthnIdentity.query().columns(LINK_COLUMNS).where('provider', provider).where('subject', subject);
    // MySQL and MSSQL default collations ignore case (and accents or trailing spaces): a subject differing only that
    // way must not sign in as another account.
    const exact = rows.find((r) => r.provider === provider && r.subject === subject);
    return exact ? toLink(exact) : null;
  }

  public async list(identity: IdentityRef): Promise<readonly IdentityLink[]> {
    const { type, id } = identityParts(identity);
    const rows = await AuthnIdentity.query().columns(LINK_COLUMNS).where('identity_type', type).where('identity_id', id).orderBy('linked_at');
    return rows.filter((r) => r.identity_type === type && r.identity_id === id).map(toLink);
  }

  /** A duplicate (provider, subject) rejects with `ResourceDuplicated` (the unique index decides). */
  public async link(identity: IdentityRef, external: ExternalSubject): Promise<IdentityLink> {
    const { type, id } = identityParts(identity);
    const provider = checkedText(external?.provider, 128, 'DbIdentityLinkStore: provider');
    const subject = checkedText(external.subject, 255, 'DbIdentityLinkStore: subject');
    const email = external.email === undefined || external.email === null ? undefined : checkedText(external.email, 255, 'DbIdentityLinkStore: email', true);
    const nowMs = checkedMs(new Date(), 'DbIdentityLinkStore.link: the clock');

    const linkId = randomUUID();
    try {
      await AuthnIdentity.insert(columnValues<AuthnIdentity>({ id: linkId, identity_type: type, identity_id: id, provider, subject, email: email ?? null, email_verified: external.emailVerified === true, attributes: null, linked_at: instant(nowMs), last_used_at: null }));
    } catch (err) {
      if (err instanceof UniqueViolation) throw new ResourceDuplicated(`DbIdentityLinkStore: (${provider}, subject) is already linked`, err);
      throw err;
    }
    return { id: linkId, identity: { type, id }, provider, subject, ...(email !== undefined ? { email } : {}), linkedAt: new Date(nowMs) };
  }

  public async unlink(id: string): Promise<void> {
    await AuthnIdentity.destroy().where('id', id);
  }

  /** Sets `last_used_at` (default now); true when the link exists. */
  public async touch(id: string, at: Date = new Date()): Promise<boolean> {
    const ms = checkedMs(at, 'DbIdentityLinkStore.touch: at');
    const { RowsAffected } = await AuthnIdentity.update({ last_used_at: instant(ms) }).where('id', id);
    return RowsAffected === 1;
  }
}

function toLink(r: AuthnIdentity): IdentityLink {
  return {
    id: r.id,
    identity: { type: r.identity_type, id: r.identity_id },
    provider: r.provider,
    subject: r.subject,
    ...(r.email !== null && r.email !== undefined ? { email: r.email } : {}),
    linkedAt: dateOf(r.linked_at),
    ...(r.last_used_at ? { lastUsedAt: dateOf(r.last_used_at) } : {}),
  };
}
