import { createHash } from 'node:crypto';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, ExternalSubject, IdentityRef, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import type { FakeIdentityStore } from './identity.js';
import { FAKE_DUMMY_HASH, fakeVerify } from './passwords.js';
import type { MemoryPasswordCredentialStore } from './passwords.js';

export interface FakeStrategyOptions {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly interactive: boolean;
  readonly verify: (c: Credentials, ctx: AuthnContext) => StrategyOutcome | Promise<StrategyOutcome>;
  readonly keys: (c: Credentials, ctx: AuthnContext) => readonly ThrottleKey[];
  /** The provider's own linking switches `linkingFor` answers (K6); both off when unset. */
  readonly linking?: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
}

const UNSUPPORTED: StrategyOutcome = { ok: false, reason: 'unsupported_credentials' };
const INVALID: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };
const pair = (account: string, ip: string | undefined): ThrottleKey[] => [
  { kind: 'account', value: account },
  { kind: 'account-ip', value: `${account}|${ip ?? ''}` },
];

export class FakeStrategy extends AuthenticationStrategy {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly interactive: boolean;
  readonly verifyCalls: Credentials[] = [];
  readonly keyCalls: Credentials[] = [];

  constructor(private readonly opts: FakeStrategyOptions) {
    super();
    this.name = opts.name;
    this.kinds = opts.kinds;
    this.interactive = opts.interactive;
  }

  throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    this.keyCalls.push(c);
    return this.opts.keys(c, ctx);
  }

  async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    this.verifyCalls.push(c);
    return this.opts.verify(c, ctx);
  }

  /** @spinajs/authn's ExternalLinkingStrategy: the core needs these and authn.linking for JIT and linking by email. */
  linkingFor(_external: ExternalSubject): { jit: boolean; byVerifiedEmail: boolean } {
    return { jit: this.opts.linking?.jit === true, byVerifiedEmail: this.opts.linking?.byVerifiedEmail === true };
  }

  static password(o: { identities: FakeIdentityStore; passwords: MemoryPasswordCredentialStore; name?: string }): FakeStrategy {
    return new FakeStrategy({
      name: o.name ?? 'local',
      kinds: ['password'],
      interactive: true,
      keys: (c, ctx) => (c.kind === 'password' ? pair(String(c.login).toLowerCase(), ctx.ip) : []),
      verify: async (c) => {
        if (c.kind !== 'password') {
          return UNSUPPORTED;
        }
        const password = String(c.password);
        const id = await o.identities.findByLogin(String(c.login));
        const hash = id ? await o.passwords.get(id) : null;
        if (!id || hash === null) {
          fakeVerify(FAKE_DUMMY_HASH, password);
          return INVALID;
        }
        return fakeVerify(hash, password) ? { ok: true, identity: id, method: 'password' } : INVALID;
      },
    });
  }

  static bearer(o: { tokens: ReadonlyMap<string, IdentityRef>; name?: string; attributes?: Readonly<Record<string, unknown>> }): FakeStrategy {
    return new FakeStrategy({
      name: o.name ?? 'token',
      kinds: ['bearer'],
      interactive: false,
      keys: (c, ctx) => (c.kind === 'bearer' ? pair('tok:' + createHash('sha256').update(String(c.token)).digest('hex').slice(0, 16), ctx.ip) : []),
      verify: async (c) => {
        if (c.kind !== 'bearer') {
          return UNSUPPORTED;
        }
        const id = o.tokens.get(String(c.token));
        if (!id) {
          return INVALID;
        }
        return { ok: true, identity: id, method: 'token', ...(o.attributes ? { attributes: o.attributes } : {}) };
      },
    });
  }

  /** Its provider's own linking switches are on unless `linking` says otherwise, so authn.linking alone decides. */
  static external(o: { provider: string; subjects: ReadonlyMap<string, ExternalSubject>; name?: string; linking?: { jit: boolean; byVerifiedEmail: boolean } }): FakeStrategy {
    const subjectOf = (c: Credentials) => (c.kind === 'external' && c.provider === o.provider ? (c as { payload: Record<string, unknown> }).payload?.subject : undefined);
    return new FakeStrategy({
      name: o.name ?? 'fake-idp',
      kinds: ['external'],
      interactive: true,
      linking: o.linking ?? { jit: true, byVerifiedEmail: true },
      keys: (c) => {
        const subject = subjectOf(c);
        return typeof subject === 'string' ? [{ kind: 'account', value: `${o.provider}:${subject}` }] : [];
      },
      verify: async (c) => {
        if (c.kind !== 'external' || c.provider !== o.provider) {
          return UNSUPPORTED;
        }
        const subject = subjectOf(c);
        const external = typeof subject === 'string' ? o.subjects.get(subject) : undefined;
        return external ? { ok: true, external, method: 'oidc' } : INVALID;
      },
    });
  }
}
