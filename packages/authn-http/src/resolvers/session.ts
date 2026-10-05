import { Autoinject, Container, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { AuthnImpersonationService } from '@spinajs/authn';
import { IdentityStore, PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnContext, Ceiling, Credentials, IdentityRef, IdentityStatus, Principal } from '@spinajs/authn/contracts';
import type { Request } from '@spinajs/http';

import { AuthnPrincipalResolver } from '../api.js';

type Restored = NonNullable<Request['storage']['AuthnSession']>;

/** Session data key of the role chosen by a role switch (D14). */
export const ACTIVE_ROLE_KEY = 'ActiveRole';

// N1 vouches for these through the strategies' own record checks and never asks the store about them (D4b).
const VOUCHED_TYPES: ReadonlySet<string> = new Set(['service', 'agent']);

const refused = (st: IdentityStatus): boolean => !st.exists || st.deleted || st.banned || !st.active;

function activeRoleCeiling(data: ReadonlyMap<string, unknown>): Ceiling | undefined {
  const role = data.get(ACTIVE_ROLE_KEY);
  if (role === undefined || role === null) return undefined;
  // A value no role switch writes narrows to no role instead of lifting the narrowing.
  return { roles: typeof role === 'string' && role !== '' ? [role] : [] };
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
    if (session.handle.state !== 'active') return null;

    // Loaded here, not at module load: the @spinajs/authn root registers its services in every app that imports it.
    const { AuthnImpersonationService } = await import('@spinajs/authn');
    const impersonation = await this.Container.resolve(AuthnImpersonationService);
    const principal = await impersonation.principalOf(session.handle, ctx);
    if (!principal) {
      await this.endRefused(session, impersonation);
      return null;
    }

    const ceiling = activeRoleCeiling(session.data);
    if (!ceiling) return principal;
    const factory = await this.Container.resolve(PrincipalFactory);
    return factory.principalOf(session.identity, session.facts, { ceiling });
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
