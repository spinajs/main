import { AsyncService, Autoinject, PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { _is_string, _non_empty, _try_check_arg } from '@spinajs/util';

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
export class FreshAuthCheck extends AsyncService {
  @Config('authn.freshAuth.maxAgeSeconds')
  protected MaxAgeSeconds: number;

  @Autoinject(SessionIssuer, { check: true })
  protected Sessions: SessionIssuer;

  @Autoinject(AuthnService)
  protected Authn: AuthnService;

  public get maxAgeSeconds(): number {
    return this.MaxAgeSeconds;
  }

  /** `reauth` is verified only when the session is not fresh. */
  public async check(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<boolean> {
    const [ok, id] = _try_check_arg(_is_string(_non_empty()))((session as Partial<SessionHandle> | null | undefined)?.id, 'session.id');
    if (!ok) return false;
    const stored = await this.Sessions.restore(id);
    if (!stored || stored.handle.state !== 'active' || stored.facts.impersonator !== undefined) return false;
    if (isFresh(stored.facts, ctx.now, this.MaxAgeSeconds)) return true;
    return reauth !== undefined && (await this.Authn.reauthenticate(session, reauth, ctx));
  }
}
