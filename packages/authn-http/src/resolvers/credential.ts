import { Autoinject, Container, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AuthnService } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, Principal } from '@spinajs/authn/contracts';
import type { Request } from '@spinajs/http';

import { AuthnPrincipalResolver } from '../api.js';

const KEY_KINDS: ReadonlySet<string> = new Set(['jws-assertion', 'http-signature']);

async function principalOf(container: IContainer, credentials: Credentials, ctx: AuthnContext): Promise<Principal | null> {
  const service = await container.resolve(AuthnService);
  const result = await service.authenticate(credentials, { ...ctx, purpose: 'request' });
  return result.status === 'success' ? service.principalOf(result) : null;
}

/** Order 45: jws-assertion and http-signature credentials. The key owner (user, service or agent per the key record) with the key's scope as ceiling (§22.10). */
@PerChildInstance()
export class KeyPrincipalResolver extends AuthnPrincipalResolver {
  public readonly order: number = 45;

  @Autoinject(Container)
  protected Container!: IContainer;

  public async resolve(_req: Request, credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined> {
    return credentials && KEY_KINDS.has(credentials.kind) ? principalOf(this.Container, credentials, ctx) : undefined;
  }
}

/**
 * Order 50: bearer credentials. An spt_ token gives its owner with ceiling.roles = the token's roles plus its Scope ceiling;
 * Scope.agent gives an agent principal, onBehalfOf the owner, delegation 'inherit', ceiling reason 'out_of_scope' (A15).
 * A JWT gives the linked user (§22.9).
 */
@PerChildInstance()
export class TokenPrincipalResolver extends AuthnPrincipalResolver {
  public readonly order: number = 50;

  @Autoinject(Container)
  protected Container!: IContainer;

  public async resolve(_req: Request, credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined> {
    return credentials?.kind === 'bearer' ? principalOf(this.Container, credentials, ctx) : undefined;
  }
}
