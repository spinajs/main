import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, IdentityLinkStore, IdentityStore, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';

import type { OidcExternalSubject, OidcStrategyName } from './contracts.js';
import { decodeFlow } from './flow/cookie.js';
import type { OidcFlow } from './flow/cookie.js';
import type { OidcCallbackQuery, OidcProvider } from './provider.js';
import { isPlainObject } from './support.js';

/** What the callback route passes as `Credentials.payload` of kind 'external'. */
export interface OidcCallbackPayload {
  /** The raw flow cookie value. */
  readonly flow: string;
  readonly query: OidcCallbackQuery;
}

export interface OidcStrategyDeps {
  readonly provider: OidcProvider;
  readonly links: IdentityLinkStore;
  /** Needed only for a provider that links by verified email without JIT. */
  readonly identities?: IdentityStore | null;
  /** The global authn.linking switches the core applies (default off). */
  readonly linking?: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
}

/**
 * Verified subjects by credentials object, for the login route's hook fan-out. Module-wide, not per instance: the core's
 * registry may build its own strategy instance per container, and the route must still find what that instance verified.
 */
const verifiedSubjects = new WeakMap<object, OidcExternalSubject>();

const foldAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const QUERY_KEYS = ['code', 'state', 'iss', 'error'] as const;

/** Only string members the callback uses; anything else in a hostile payload reads as absent. */
function queryOf(v: unknown): OidcCallbackQuery | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, string> = {};
  for (const k of QUERY_KEYS) {
    const x = v[k];
    if (x === undefined) continue;
    if (typeof x !== 'string') return null;
    out[k] = x;
  }
  return out;
}

const FAILED: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };
const NOT_LINKED: StrategyOutcome = { ok: false, reason: 'not_linked' };
const UNSUPPORTED: StrategyOutcome = { ok: false, reason: 'unsupported_credentials' };

/**
 * `oidc:<name>` (design §22.15, A27): verifies an OIDC callback (state, code, ID token, userinfo) and answers the mapped
 * external subject; AuthnService links, provisions and issues the session. The provider's own linking switches are
 * enforced here (D5), since the core applies only the global ones. The subject of each successful verify is kept for the
 * login route's ExternalLoginHook fan-out (`verified`).
 */
export class OidcStrategy extends AuthenticationStrategy {
  public readonly name: OidcStrategyName;
  public readonly kinds: readonly string[] = Object.freeze(['external']);
  public readonly interactive = true;

  constructor(protected readonly deps: OidcStrategyDeps) {
    super();
    this.name = deps.provider.options.strategy;
  }

  public get provider(): OidcProvider {
    return this.deps.provider;
  }

  /** N1's CredentialSelector: only this provider's external credentials. */
  public accepts(c: Credentials): boolean {
    try {
      return isPlainObject(c) && c.kind === 'external' && c.provider === this.name;
    } catch {
      return false;
    }
  }

  /** No account is known before verification, and a per-provider key would let one client slow every login (D17); the core adds the ip key. */
  public throttleKeys(): readonly ThrottleKey[] {
    return [];
  }

  /** The subject a successful verify of exactly these credentials answered. */
  public verified(c: Credentials): OidcExternalSubject | undefined {
    const s = isPlainObject(c) ? verifiedSubjects.get(c) : undefined;
    return s?.provider === this.name ? s : undefined;
  }

  public async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    const input = this.callbackOf(c);
    if (input === null) return UNSUPPORTED;
    if (input.flow === null || input.flow.m !== 'login') return FAILED;
    let external: OidcExternalSubject;
    try {
      external = await this.deps.provider.complete(input.flow, input.query, ctx.now);
    } catch {
      return FAILED;
    }
    let gated: OidcExternalSubject | null;
    try {
      gated = await this.gate(external);
    } catch {
      return FAILED;
    }
    if (gated === null) return NOT_LINKED;
    verifiedSubjects.set(c, gated);
    return { ok: true, external: gated, method: 'oidc' };
  }

  /**
   * A link flow's callback (D16): the same checks as a login, for a flow started by the session whose raw id hashes to
   * `sessionHash`; no linking switch applies, the caller links explicitly. Throws on any failure.
   */
  public async verifyLink(c: Credentials, sessionHash: string, ctx: AuthnContext): Promise<OidcExternalSubject> {
    const input = this.callbackOf(c);
    if (input === null || input.flow === null || input.flow.m !== 'link' || input.flow.h !== sessionHash) {
      throw new Error('authn-oidc: not a link callback of this session');
    }
    return this.deps.provider.complete(input.flow, input.query, ctx.now);
  }

  protected callbackOf(c: Credentials): { flow: OidcFlow | null; query: OidcCallbackQuery } | null {
    try {
      if (!this.accepts(c)) return null;
      const payload = (c as { payload?: unknown }).payload;
      if (!isPlainObject(payload)) return null;
      const query = queryOf(payload.query);
      if (query === null) return null;
      return { flow: decodeFlow(payload.flow), query };
    } catch {
      return null;
    }
  }

  /**
   * D5: null when the provider's own switches forbid this unlinked subject; else the subject the core may use. The core
   * (N1) links an unlinked subject by verified email only with the global switch, and only to the identity whose stored
   * email equals it, else provisions with the global jit switch. This repeats that decision so neither path runs without
   * the provider's switch too.
   */
  protected async gate(external: OidcExternalSubject): Promise<OidcExternalSubject | null> {
    const own = this.deps.provider.options.linking;
    const global = this.deps.linking ?? { jit: false, byVerifiedEmail: false };
    // The global switch alone must never link by email, so the core sees a verified email only with the provider's switch on.
    const subject: OidcExternalSubject = external.email !== undefined && external.emailVerified === true && !own.byVerifiedEmail ? Object.freeze({ ...external, emailVerified: false }) : external;
    if (await this.deps.links.find(subject.provider, subject.subject)) return subject;
    if (own.byVerifiedEmail && global.byVerifiedEmail && subject.emailVerified === true && subject.email !== undefined && (await this.matchesStoredEmail(subject.email))) {
      return subject;
    }
    return own.jit && global.jit ? subject : null;
  }

  protected async matchesStoredEmail(email: string): Promise<boolean> {
    const identities = this.deps.identities;
    if (!identities) return false;
    const id = await identities.findByLogin(email);
    const stored = id ? (await identities.display(id))?.email : undefined;
    return typeof stored === 'string' && stored.length > 0 && foldAscii(stored) === foldAscii(email);
  }

}
