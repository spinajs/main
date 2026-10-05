import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

import type { AuthnContext, Credentials } from '../contracts/credentials.js';
import type { AuthnFacts } from '../contracts/principal.js';
import { AuthnService } from '../contracts/service.js';
import { SessionIssuer } from '../contracts/session.js';
import type { SessionHandle } from '../contracts/session.js';

/**
 * True when `authenticatedAt` lies within `maxAgeSeconds` before `now`, the boundary included. A time after `now` or
 * an invalid one is not fresh, nor is an impersonation: the impersonator must not act on the target's credentials (M6).
 */
export function isFresh(facts: Pick<AuthnFacts, 'authenticatedAt' | 'impersonator'>, now: Date, maxAgeSeconds: number): boolean {
  if (typeof maxAgeSeconds !== 'number' || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new InvalidArgument('isFresh: maxAgeSeconds must be a positive number');
  }
  if (facts?.impersonator !== undefined) return false;
  const at = facts?.authenticatedAt;
  if (!(at instanceof Date) || !(now instanceof Date)) return false;
  const age = now.getTime() - at.getTime();
  return age >= 0 && age <= maxAgeSeconds * 1000;
}

/**
 * Fresh authentication for sensitive actions (A13): the active session authenticated within
 * `authn.freshAuth.maxAgeSeconds`, or an inline re-authentication of its identity, which counts for this request only.
 * One per container. Not named FreshAuth: DI keys classes by name, and authn-http's route policy has that name.
 */
@PerChildInstance()
@Inject(Container)
export class FreshAuthCheck extends AsyncService {
  @Config('authn.freshAuth.maxAgeSeconds')
  protected MaxAgeSeconds: number;

  private authn!: AuthnService;
  private sessions!: SessionIssuer;

  constructor(private readonly container: IContainer) {
    super();
  }

  public get maxAgeSeconds(): number {
    return this.MaxAgeSeconds;
  }

  public async resolve(): Promise<void> {
    if (!this.container.hasRegistered(SessionIssuer as unknown as Class<SessionIssuer>)) throw new InvalidOperation('FreshAuthCheck: no SessionIssuer is registered');
    this.sessions = (await this.container.resolve(SessionIssuer as unknown as Class<SessionIssuer>)) as SessionIssuer;
    this.authn = (await this.container.resolve(AuthnService as unknown as Class<AuthnService>)) as AuthnService;
    await super.resolve();
  }

  /** `reauth` is verified only when the session is not fresh. */
  public async check(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<boolean> {
    const id: unknown = (session as Partial<SessionHandle> | null | undefined)?.id;
    if (typeof id !== 'string' || id === '') return false;
    const stored = await this.sessions.restore(id);
    if (!stored || stored.handle.state !== 'active' || stored.facts.impersonator !== undefined) return false;
    if (isFresh(stored.facts, ctx.now, this.MaxAgeSeconds)) return true;
    return reauth !== undefined && (await this.authn.reauthenticate(session, reauth, ctx));
  }
}
