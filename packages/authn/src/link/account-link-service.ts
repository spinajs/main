import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { isNonEmptyString, isPlainObject } from '@spinajs/util';

import type { AuthnEvent } from '../contracts/audit.js';
import type { AuthnContext, Credentials, ExternalSubject, IdentityRef } from '../contracts/credentials.js';
import { errorClass } from '../support/guards.js';
import { KeyRegistry } from '../contracts/keys.js';
import type { KeyRecord } from '../contracts/keys.js';
import { IdentityLinkStore } from '../contracts/link.js';
import type { IdentityLink } from '../contracts/link.js';
import { IdentityStore, PasswordCredentialStore } from '../contracts/identity.js';
import type { IdentityStatus } from '../contracts/identity.js';
import { SessionIssuer } from '../contracts/session.js';
import type { SessionHandle } from '../contracts/session.js';
import { AuthnAudit } from '../audit/authn-audit.js';
import { FreshAuthCheck } from '../freshauth/fresh-auth-check.js';

// TODO: eplain in readme.md in this folder how linking works
// * entry points,
// * DI registration
// * linking flow, how its related to user session, session states etc.
 

export type LinkResult = { readonly ok: true; readonly link: IdentityLink } | { readonly ok: false };


type Holder = { readonly identity: IdentityRef; readonly session?: string };

type Guarded = { readonly holder?: Holder; readonly refused?: string };

type LinkEvent = 'identity.link' | 'identity.unlink';







const sameRef = (a: IdentityRef, b: IdentityRef): boolean => a.type === b.type && a.id === b.id;


/** Strategies vouch for these through their own record checks; every other type is asked (D4b). */
const VOUCHED_TYPES: ReadonlySet<string> = new Set(['service', 'agent']);

function refusal(st: IdentityStatus): string | null {
  if (!st.exists) return 'unknown_identity';
  if (st.deleted) return 'deleted';
  if (st.banned) return 'banned';
  if (!st.active) return 'inactive';
  return null;
}

// Per process, across containers: two parallel unlinks must not both see the other link as the remaining credential.
const unlinking = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(id: IdentityRef, run: () => Promise<T>): Promise<T> {
  const key = `${id.type}\u0000${id.id}`;
  const mine = (unlinking.get(key) ?? Promise.resolve()).then(run, run);
  const tail = mine.catch(() => undefined);
  unlinking.set(key, tail);
  try {
    return await mine;
  } finally {
    if (unlinking.get(key) === tail) unlinking.delete(key);
  }
}

const usable = (k: KeyRecord, owner: IdentityRef, now: Date): boolean => isPlainObject(k) && isPlainObject(k.owner) && sameRef(k.owner, owner) && k.revokedAt === undefined && (k.expiresAt === undefined || (k.expiresAt instanceof Date && now.getTime() < k.expiresAt.getTime()));

/**
 * Explicit linking and unlinking of external subjects (A19, design §22.12). Both need the identity's own active
 * session, not an impersonation, with fresh auth or an inline re-authentication, and a context with
 * `purpose: 'link'`. `external` must come from a verified external login (the OIDC callback): this service cannot
 * check that the caller controls the subject.
 *
 * Refusals answer `{ ok: false }` only, so the answer never says whether a subject is linked to someone else; the
 * reason goes to audit. Unlinking is owner-bound and never removes the last usable credential: a password, another
 * link, or a key that is neither revoked nor expired (keys count only when a KeyRegistry is registered). Unlinks of
 * one identity run one at a time within a process; across processes the link store must guard the check and delete.
 * Usable means present: a link whose provider is no longer configured, or a password or key without a listed
 * strategy for it, still counts.
 *
 * The holder's status is checked as at login (D4b), so a banned identity with a live session changes nothing.
 *
 * One per container (D11).
 */
@PerChildInstance()
@Inject(Container)
export class AccountLinkService extends AsyncService {
  private links!: IdentityLinkStore;
  private identities!: IdentityStore;
  private sessions!: SessionIssuer;
  private fresh!: FreshAuthCheck;
  private auditor!: AuthnAudit;
  private passwords: PasswordCredentialStore | undefined;
  private keys: KeyRegistry | undefined;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    this.links = await this.container.resolve(IdentityLinkStore, true);
    this.sessions = await this.container.resolve(SessionIssuer, true);
    this.identities = await this.container.resolve(IdentityStore, true);
    this.passwords = this.container.hasRegistered(PasswordCredentialStore) ? await this.container.resolve(PasswordCredentialStore) : undefined;
    this.keys = this.container.hasRegistered(KeyRegistry) ? await this.container.resolve(KeyRegistry) : undefined;
    this.fresh = await this.container.resolve(FreshAuthCheck);
    this.auditor = await this.container.resolve(AuthnAudit);
    await super.resolve();
  }

  /** `reauth` is verified only when the session is not fresh. */
  public async link(session: SessionHandle, external: ExternalSubject, ctx: AuthnContext, reauth?: Credentials): Promise<LinkResult> {
    let holder: Holder | undefined;
    try {
      const guard = await this.guard(session, ctx, reauth);
      holder = guard.holder;
      if (guard.refused !== undefined || !holder) return await this.refuse(ctx, 'identity.link', guard.refused ?? 'not_active', holder);
      if (!isPlainObject(external) || !isNonEmptyString(external.provider) || !isNonEmptyString(external.subject)) return await this.refuse(ctx, 'identity.link', 'invalid_subject', holder);
      const taken = await this.links.find(external.provider, external.subject);
      if (taken) return await this.refuse(ctx, 'identity.link', sameRef(taken.identity, holder.identity) ? 'already_linked' : 'linked_elsewhere', holder);
      // The store's unique (provider, subject) index decides a race between two links of one subject; its error lands below.
      const link = await this.links.link(holder.identity, external);
      await this.audit(ctx, { type: 'identity.link', outcome: 'success', ...holder, data: { provider: link.provider, link: link.id } });
      return { ok: true, link };
    } catch (err) {
      return this.refuse(ctx, 'identity.link', 'store_error', holder, { error: errorClass(err) });
    }
  }

  /** `reauth` is verified only when the session is not fresh. */
  public async unlink(session: SessionHandle, linkId: string, ctx: AuthnContext, reauth?: Credentials): Promise<{ ok: boolean }> {
    let holder: Holder | undefined;
    try {
      const guard = await this.guard(session, ctx, reauth);
      holder = guard.holder;
      if (guard.refused !== undefined || !holder) return await this.refuse(ctx, 'identity.unlink', guard.refused ?? 'not_active', holder);
      const h = holder;
      return await oneAtATime(h.identity, async () => {
        // Found among the holder's own links, never by id alone.
        const own = await this.links.list(h.identity);
        const target = isNonEmptyString(linkId) ? own.find((l) => l.id === linkId) : undefined;
        if (!target) return this.refuse(ctx, 'identity.unlink', 'unknown_link', h);
        if (!(await this.hasOtherCredential(h.identity, own.length - 1, ctx.now))) return this.refuse(ctx, 'identity.unlink', 'last_credential', h);
        await this.links.unlink(target.id);
        await this.audit(ctx, { type: 'identity.unlink', outcome: 'success', ...h, data: { provider: target.provider, link: target.id } });
        return { ok: true };
      });
    } catch (err) {
      return this.refuse(ctx, 'identity.unlink', 'store_error', holder, { error: errorClass(err) });
    }
  }

  /** The session's identity, and the audit reason when it may not change its links. */
  private async guard(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<Guarded> {
    if (!isPlainObject(session) || !isNonEmptyString(session.id)) return { refused: 'not_active' };
    const stored = await this.sessions.restore(session.id);
    if (!stored || stored.handle.state !== 'active') return { refused: 'not_active' };
    const holder: Holder = { identity: stored.identity, ...(isNonEmptyString(stored.facts.sessionHandle) ? { session: stored.facts.sessionHandle } : {}) };
    if (ctx.purpose !== 'link') return { holder, refused: 'wrong_purpose' };
    // An impersonator acting as the target must not attach a login of their own to it.
    if (stored.facts.impersonator !== undefined) return { holder, refused: 'impersonating' };
    const status = VOUCHED_TYPES.has(holder.identity.type) ? null : refusal(await this.identities.status(holder.identity));
    if (status) return { holder, refused: status };
    if (!(await this.fresh.check(session, { ...ctx, purpose: 'reauth' }, reauth))) return { holder, refused: 'not_fresh' };
    return { holder };
  }

  private async hasOtherCredential(id: IdentityRef, otherLinks: number, now: Date): Promise<boolean> {
    if (otherLinks > 0) return true;
    if (this.passwords && isNonEmptyString(await this.passwords.get(id))) return true;
    if (!this.keys) return false;
    const keys: unknown = await this.keys.list(id);
    return Array.isArray(keys) && keys.some((k: KeyRecord) => usable(k, id, now));
  }

  private async refuse(ctx: AuthnContext, type: LinkEvent, reason: string, holder?: Holder, data?: Readonly<Record<string, unknown>>): Promise<{ ok: false }> {
    await this.audit(ctx, { type, outcome: 'failure', reason, ...(holder ?? {}), ...(data ? { data } : {}) });
    return { ok: false };
  }

  private audit(ctx: AuthnContext, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
    return this.auditor.publish({ ...e, at: ctx.now, ...(isNonEmptyString(ctx.ip) ? { ip: ctx.ip } : {}), ...(isNonEmptyString(ctx.userAgent) ? { userAgent: ctx.userAgent } : {}) });
  }
}
