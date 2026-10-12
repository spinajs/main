import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

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
    this.sessions = await this.container.resolve(SessionIssuer, true);
    this.authn = await this.container.resolve(AuthnService);
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
