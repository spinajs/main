import sinon from 'sinon';

import type { Request } from '@spinajs/http';
import { FreshAuth } from '@spinajs/authn-http';
import { AuthzCredentialAdminRule } from '@spinajs/users';

/** What a suite calling the lifecycle handlers directly passes as the request: fresh auth is stubbed there. */
export const NO_REQUEST = undefined as unknown as Request;

/**
 * Lets the handler suites reach the AccountGuard: deactivate, ban and delete ask fresh auth and the credential admin
 * rule first, which need a request and a signed-in session these suites do not have. Both gates are pinned over
 * http in `v3/lifecycle-guard.test.ts`; users' guard refuses the caller's own account there, so the self-lockout cases
 * of these suites describe the AccountGuard behind an application guard that admits it. Undone by `sinon.restore()`.
 */
export function passLifecycleGates(): void {
  sinon.stub(FreshAuth.prototype, 'execute').resolves();
  sinon.stub(AuthzCredentialAdminRule.prototype, 'allowed').resolves({ ok: true });
}
