import { AuthnService } from '@spinajs/authn/contracts';
import type { AuthenticationResult, AuthenticationStrategy, AuthnContext, AuthnEvent, AuthnEventSink, AuthnFacts, AuthnFailure, AuthnThrottle, Credentials, ExternalSubject, IdentityLinkStore, IdentityRef, IdentityStatus, IdentityStore, MfaPolicy, MfaStep, PrincipalFactory, Principal, SessionHandle, SessionIssuer, ThrottleKey } from '@spinajs/authn/contracts';

export interface FakeAuthnServiceDeps {
  readonly strategies: readonly AuthenticationStrategy[];
  readonly throttle: AuthnThrottle;
  readonly identities: IdentityStore;
  readonly links: IdentityLinkStore;
  readonly linking: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
  readonly policy: MfaPolicy;
  readonly steps: readonly MfaStep[];
  readonly sessions: SessionIssuer;
  /** Read at publish time, so a sink may be added after the service is built. */
  readonly sinks: readonly AuthnEventSink[];
  readonly principals: PrincipalFactory;
}

type Success = Extract<AuthenticationResult, { status: 'success' }>;
type Failure = Extract<AuthenticationResult, { status: 'failure' }>;

const failure = (reason: AuthnFailure): Failure => ({ status: 'failure', reason });
const throttled = (retryAfterSeconds: number): Failure => ({ status: 'failure', reason: 'throttled', retryAfterSeconds });

/**
 * The authentication flow over the contracts, for lanes that need a `service` port before N1's AuthnService:
 * route by credential kind, count the attempt (strategy keys + ip) before verify, audit every failure with its real
 * reason, answer status refusals as invalid_credentials, link or provision external subjects, issue a pending
 * session when MFA is required, elevate on completeMfa, and re-authenticate without touching the session.
 * A fake, not N1's implementation.
 */
export class FakeAuthnService extends AuthnService {
  /** Subclasses may turn this off to claim the slot only after verification (the A05 mutation check). */
  protected countBeforeVerify = true;

  constructor(protected readonly d: FakeAuthnServiceDeps) {
    super();
  }

  strategies(): readonly AuthenticationStrategy[] {
    return this.d.strategies;
  }

  /** The audit reason of a status that refuses login, or null. */
  protected statusReason(st: IdentityStatus): string | null {
    if (!st.exists) return 'unknown_identity';
    if (st.deleted) return 'deleted';
    if (st.banned) return 'banned';
    if (!st.active) return 'inactive';
    return null;
  }

  protected async audit(ctx: AuthnContext, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
    const event: AuthnEvent = { at: ctx.now, ...(ctx.ip ? { ip: ctx.ip } : {}), ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}), ...e };
    for (const sink of this.d.sinks) {
      await sink.publish(event);
    }
  }

  private keysFor(base: readonly ThrottleKey[], ctx: AuthnContext): ThrottleKey[] {
    return [...base, ...(ctx.ip ? [{ kind: 'ip', value: ctx.ip }] : [])];
  }

  private async linkedIdentity(external: ExternalSubject): Promise<IdentityRef | null> {
    const link = await this.d.links.find(external.provider, external.subject);
    if (link) return link.identity;
    let id: IdentityRef | null = null;
    if (this.d.linking.byVerifiedEmail && external.emailVerified && external.email) {
      id = await this.d.identities.findByLogin(external.email);
    }
    if (!id && this.d.linking.jit && this.d.identities.provision) {
      id = await this.d.identities.provision(external);
    }
    if (id) await this.d.links.link(id, external);
    return id;
  }

  private async handleOf(h: SessionHandle): Promise<string | undefined> {
    return (await this.d.sessions.restore(h.id))?.facts.sessionHandle;
  }

  async authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult> {
    const s = this.d.strategies.find((x) => x.kinds.includes(c.kind));
    if (!s) {
      await this.audit(ctx, { type: 'login', outcome: 'failure', reason: 'unsupported_credentials' });
      return failure('unsupported_credentials');
    }
    const keys = this.keysFor(s.throttleKeys(c, ctx), ctx);
    const gate = async () => {
      const t = await this.d.throttle.attempt(keys, 'login', ctx);
      if (!t.allowed) {
        await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', strategy: s.name, reason: 'throttled' });
        return throttled(t.retryAfterSeconds);
      }
      return null;
    };
    const early = this.countBeforeVerify ? await gate() : null;
    if (early) return early;
    const r = await s.verify(c, ctx);
    const late = this.countBeforeVerify ? null : await gate();
    if (late) return late;
    if (!r.ok) {
      await this.audit(ctx, { type: 'login', outcome: 'failure', strategy: s.name, reason: r.reason });
      return failure(r.reason);
    }
    const id = r.identity ?? (r.external ? await this.linkedIdentity(r.external) : null);
    if (!id) {
      await this.audit(ctx, { type: 'login', outcome: 'failure', strategy: s.name, reason: 'not_linked' });
      return failure('not_linked');
    }
    const refused = this.statusReason(await this.d.identities.status(id));
    if (refused) {
      await this.audit(ctx, { type: 'login', outcome: 'failure', strategy: s.name, identity: id, reason: refused });
      return failure('invalid_credentials');
    }
    await this.d.throttle.succeed(keys, 'login');
    const facts = { method: r.method, strategy: s.name, assurance: 'aal1' as const, mfa: [] as string[] };
    const extra = { ...(r.ceiling ? { ceiling: r.ceiling } : {}), ...(r.delegation ? { delegation: r.delegation } : {}), ...(r.attributes ? { attributes: r.attributes } : {}) };
    if (!s.interactive) {
      await this.audit(ctx, { type: 'token.use', outcome: 'success', strategy: s.name, identity: id });
      return { status: 'success', identity: id, facts, ...extra };
    }
    const steps = await this.d.policy.required(id, facts);
    if (steps.length > 0) {
      const pending = await this.d.sessions.issue(id, { ...facts, authenticatedAt: ctx.now }, { pending: { steps } });
      await this.audit(ctx, { type: 'mfa.challenge', outcome: 'success', strategy: s.name, identity: id, session: await this.handleOf(pending) });
      return { status: 'mfa_required', pending, steps };
    }
    const session = await this.d.sessions.issue(id, { ...facts, authenticatedAt: ctx.now });
    const handle = await this.handleOf(session);
    await this.audit(ctx, { type: 'login', outcome: 'success', strategy: s.name, identity: id, session: handle });
    await this.audit(ctx, { type: 'session.issue', outcome: 'success', strategy: s.name, identity: id, session: handle });
    return { status: 'success', identity: id, facts: { ...facts, sessionHandle: handle }, session, ...extra };
  }

  async completeMfa(pending: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult> {
    const restored = await this.d.sessions.restore(pending.id);
    if (!restored || restored.handle.state !== 'pending') {
      return failure('invalid_credentials');
    }
    const id = restored.identity;
    const mfaStep = this.d.steps.find((x) => x.name === step);
    const recovery = step === 'recovery' ? this.d.steps.filter((x) => typeof x.verifyRecovery === 'function') : [];
    if (!mfaStep && recovery.length === 0) {
      await this.audit(ctx, { type: 'mfa.verify', outcome: 'failure', identity: id, reason: 'unknown_step' });
      return failure('invalid_credentials');
    }
    const keys = this.keysFor(
      [
        { kind: 'account', value: id.id },
        { kind: 'account-ip', value: `${id.id}|${ctx.ip ?? ''}` },
      ],
      ctx,
    );
    const t = await this.d.throttle.attempt(keys, 'mfa', ctx);
    if (!t.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', identity: id, reason: 'throttled' });
      return throttled(t.retryAfterSeconds);
    }
    let ok = false;
    if (mfaStep) {
      ok = await mfaStep.verify(id, response);
    } else {
      for (const r of recovery) ok = ok || (await r.verifyRecovery!(id, response));
    }
    if (!ok) {
      await this.audit(ctx, { type: 'mfa.verify', outcome: 'failure', identity: id, reason: 'invalid_code' });
      return failure('invalid_credentials');
    }
    await this.d.throttle.succeed(keys, 'mfa');
    const session = await this.d.sessions.elevate(pending, { assurance: 'aal2', mfa: [step] });
    const now = await this.d.sessions.restore(session.id);
    const { authenticatedAt: _at, ...facts } = now!.facts;
    await this.audit(ctx, { type: 'mfa.verify', outcome: 'success', identity: id, session: facts.sessionHandle });
    await this.audit(ctx, { type: 'login', outcome: 'success', strategy: facts.strategy, identity: id, session: facts.sessionHandle });
    return { status: 'success', identity: id, facts, session };
  }

  async reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean> {
    const restored = await this.d.sessions.restore(session.id);
    const s = this.d.strategies.find((x) => x.kinds.includes(c.kind));
    if (!restored || restored.handle.state !== 'active' || !s) {
      return false;
    }
    const id = restored.identity;
    const keys = this.keysFor(
      [
        { kind: 'account', value: id.id },
        { kind: 'account-ip', value: `${id.id}|${ctx.ip ?? ''}` },
      ],
      ctx,
    );
    if (!(await this.d.throttle.attempt(keys, 'reauth', ctx)).allowed) {
      return false;
    }
    const r = await s.verify(c, ctx);
    const ok = r.ok && r.identity !== undefined && r.identity.type === id.type && r.identity.id === id.id;
    await this.audit(ctx, { type: 'reauth', outcome: ok ? 'success' : 'failure', identity: id, strategy: s.name });
    if (ok) {
      await this.d.throttle.succeed(keys, 'reauth');
    }
    return ok;
  }

  async principalOf(result: Success): Promise<Principal> {
    const stored = result.session ? (await this.d.sessions.restore(result.session.id))?.facts : undefined;
    const facts: AuthnFacts = stored ?? { ...result.facts, authenticatedAt: new Date() };
    return this.d.principals.principalOf(result.identity, facts, { ceiling: result.ceiling, attributes: result.attributes });
  }
}
