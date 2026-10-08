import { Autoinject, Container, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AuthnImpersonationService, activeRoleCeiling } from '@spinajs/authn';
import { IdentityStore, PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, IdentityRef, IdentityStatus, Principal } from '@spinajs/authn/contracts';
import type { Request } from '@spinajs/http';

import { AuthnPrincipalResolver } from '../api.js';

type Restored = NonNullable<Request['storage']['AuthnSession']>;

export { ACTIVE_ROLE_KEY } from '@spinajs/authn';

// N1 vouches for these through the strategies' own record checks and never asks the store about them (D4b).
const VOUCHED_TYPES: ReadonlySet<string> = new Set(['service', 'agent']);

const refused = (st: IdentityStatus): boolean => !st.exists || st.deleted || st.banned || !st.active;

/** `principal` of `session`, narrowed by the session's role switch (D14): the principal every request on it resolves to. */
export async function narrowedBySwitch(container: IContainer, session: Pick<Restored, 'identity' | 'facts' | 'data'>, principal: Principal): Promise<Principal> {
  const ceiling = activeRoleCeiling(session.data);
  if (!ceiling) return principal;
  const factory = await container.resolve(PrincipalFactory);
  return factory.principalOf(session.identity, session.facts, { ceiling });
}

/**
 * Order 100: req.storage.AuthnSession. Pending ⇒ null (D25, A09). Otherwise the session's user with its authn facts,
 * and ceiling.roles = [ActiveRole] after a role switch (D14). When the session yields no principal because its
 * subject or impersonator is banned, inactive or deleted, every session of that identity ends (SR-06).
 */
@PerChildInstance()
export class SessionPrincipalResolver extends AuthnPrincipalResolver {
  public readonly order: number = 100;

  @Autoinject(Container)
  protected Container!: IContainer;

  public async resolve(req: Request, _credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined> {
    const session = req.storage.AuthnSession;
    if (!session) return undefined;
    return this.principalOfSession(session, ctx);
  }

  /** The principal of a restored session without an http request: `@spinajs/authn-http/socket` resolves socket sessions with it. */
  public async principalOfSession(session: Restored, ctx: AuthnContext): Promise<Principal | null> {
    if (session.handle.state !== 'active') return null;

    const impersonation = await this.Container.resolve(AuthnImpersonationService);
    const principal = await impersonation.principalOf(session.handle, ctx);
    if (!principal) {
      await this.endRefused(session, impersonation);
      return null;
    }

    return narrowedBySwitch(this.Container, session, principal);
  }

  /** authn-http cannot see the users lifecycle actions, so a refused status found here ends the identity's sessions (N8a-D4). */
  protected async endRefused(session: Restored, impersonation: AuthnImpersonationService): Promise<void> {
    const identities = await this.Container.resolve(IdentityStore);
    const subjects: IdentityRef[] = [session.identity, ...(session.facts.impersonator ? [session.facts.impersonator] : [])];
    for (const subject of subjects) {
      if (VOUCHED_TYPES.has(subject.type)) continue;
      if (refused(await identities.status(subject))) await impersonation.endFor({ type: subject.type, id: subject.id });
    }
  }
}
