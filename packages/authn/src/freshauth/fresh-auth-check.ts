import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';

import type { AuthnContext, Credentials } from '../contracts/credentials.js';
import { isFresh } from '../contracts/fresh.js';
import { AuthnService } from '../contracts/service.js';
import { SessionIssuer } from '../contracts/session.js';
import type { SessionHandle } from '../contracts/session.js';

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

    // TODO why those casts SessionIssuer as unknown as Class<SessionIssuer> - DI container accepts Class and string identifiers, check whole project for those meaningless casts
    if (!this.container.hasRegistered(SessionIssuer as unknown as Class<SessionIssuer>)) throw new InvalidOperation('FreshAuthCheck: no SessionIssuer is registered');
    this.sessions = (await this.container.resolve(SessionIssuer as unknown as Class<SessionIssuer>)) as SessionIssuer;
    this.authn = (await this.container.resolve(AuthnService as unknown as Class<AuthnService>)) as AuthnService;
    await super.resolve();
  }

  /** `reauth` is verified only when the session is not fresh. */
  public async check(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<boolean> {
    const id: unknown = (session as Partial<SessionHandle> | null | undefined)?.id;

    // TODO use common helpers or lodash emptiness check - project wide check for those
    if (typeof id !== 'string' || id === '') return false;
    const stored = await this.sessions.restore(id);
    if (!stored || stored.handle.state !== 'active' || stored.facts.impersonator !== undefined) return false;
    if (isFresh(stored.facts, ctx.now, this.MaxAgeSeconds)) return true;
    return reauth !== undefined && (await this.authn.reauthenticate(session, reauth, ctx));
  }
}
