import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import { Permission, Resource } from '@spinajs/rbac-http';

import { TokenPolicy } from '../../src/policies/TokenPolicy.js';

/**
 * Test-only route secured the way consumers are expected to secure theirs.
 *
 * WIRING - `@Policy(TokenPolicy)` sits on the METHOD, not on the class, and that
 * placement is the whole point of this fixture.
 *
 * `createPolicyGate` ( `http/src/route-builder.ts` ) ANDs the controller scope
 * with the route scope, ORs the groups within one scope and ANDs the members of
 * a group. `@Permission` pushes `[RbacPolicy]` as a ROUTE scope group
 * ( `rbac-http/src/decorators.ts:170` ), and `RbacPolicy` demands an authorized
 * session, which a token authenticated request never has. So:
 *
 *   - class level `@Policy(TokenPolicy)` would land in the CONTROLLER scope and
 *     be ANDed with the route's `[RbacPolicy]` group - the route would be
 *     permanently unreachable by token, no matter how well the token validates.
 *   - method level `@Policy(TokenPolicy)` lands in the same ROUTE scope as
 *     `[RbacPolicy]` but as its own group, so the two are ORed: a token request
 *     passes through the TokenPolicy group, a session request through the
 *     RbacPolicy group.
 *
 * `@Permission(['readOwn'])` is still required with either placement, because
 * `TokenPolicy` reads that very metadata to learn which grant the route wants.
 *
 * ORDER within the route scope decides only which rejection the caller SEES:
 * when no group holds, `createPolicyGate` reports the first rejection in
 * declaration order. Decorators apply bottom up, so `@Policy(TokenPolicy)`
 * written LAST is pushed FIRST and a token that authenticated but lacks the
 * grant gets TokenPolicy's 403 rather than RbacPolicy's "no session" 401.
 */
@BasePath('token-protected')
@Resource('test.resource')
export class TestTokenController extends BaseController {
  @Get('data')
  @Permission(['readOwn'])
  @Policy(TokenPolicy)
  public async data(): Promise<Ok<{ ok: boolean }>> {
    return new Ok({ ok: true });
  }
}
