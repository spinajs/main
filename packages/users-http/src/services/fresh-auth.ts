import { DI } from '@spinajs/di';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { IController, IRoute, Request } from '@spinajs/http';
import { AUTHN_FAILURE_BODY, FreshAuth, authnFailureResponse } from '@spinajs/authn-http';

/**
 * authn-http's fresh auth (a recent login, or the caller's password in `reauthPassword`), run in the handler: http runs
 * a route's policies at once, so as a policy it would verify and count a password while `@Access` refuses. The package
 * exports the FreshAuth policy, not its `assertFreshAuth`. Answers the 401 of a failed re-authentication, else null;
 * throws the 403s (`fresh_auth_required`, `session_required`, `impersonating`).
 */
export async function freshAuthRefusal(req: Request, controller: IController): Promise<ReturnType<typeof authnFailureResponse> | null> {
  try {
    await ((await DI.resolve(FreshAuth)) as FreshAuth).execute(req, null as unknown as IRoute, controller);
    return null;
  } catch (err) {
    // The thrown error's body carries a stack outside production; authn-http answers the same 401 body.
    if (err instanceof AuthenticationFailed && (err as { error?: unknown }).error === AUTHN_FAILURE_BODY.error) {
      return authnFailureResponse();
    }
    throw err;
  }
}
