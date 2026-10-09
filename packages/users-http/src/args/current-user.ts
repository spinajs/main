import { AuthzService, SYSTEM, Unauthenticated } from '@spinajs/authz';
import type { IAuthzAsyncStorage, Principal } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { Parameter, Route, RouteArgs } from '@spinajs/http';
import type { IRouteArgsResult, IRouteCall, IRouteParameter, Request } from '@spinajs/http';
import { userModel } from '@spinajs/users';
import type { User } from '@spinajs/users';

/** Route arg of {@link CurrentUser}. Named apart from `User`: http resolves a route arg by its class name. */
@Injectable()
export class CurrentUserArg extends RouteArgs {
  public get SupportedType(): string {
    return 'CurrentUserArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    return { CallData: callData, Args: await currentUser((req.storage as IAuthzAsyncStorage | undefined)?.Principal) };
  }
}

async function currentUser(principal: Principal | undefined): Promise<User> {
  if (!principal || principal.authenticated !== true) {
    throw new Unauthenticated('this route needs a signed-in user');
  }
  // An agent acting for a user is not that user, as for the `self` relation.
  if (principal.type !== 'user') {
    throw new Forbidden(`this route acts for a user, not for a ${principal.type} principal`);
  }

  const authz = (await DI.resolve(AuthzService)) as AuthzService;
  // As SYSTEM: the application's user model may be scoped, and the lookup of the caller's own row must not be.
  const user = (await authz.runAs(SYSTEM, 'current-user-arg', () => userModel().query().whereUuid(principal.id).populate('Metadata').first())) as User | undefined;
  if (!user || user.DeletedAt) {
    throw new Unauthenticated('the signed-in account no longer exists');
  }

  return user;
}

/**
 * The users row of the request's signed-in user, with its metadata, read again as SYSTEM: the `@User()` of users-http
 * (design §11.1); `@CurrentPrincipal()` gives the principal. It throws rather than resolving to null, so an action never
 * runs without its user: 401 without an authenticated principal or when the account no longer exists (deleted since the
 * request authenticated), 403 for a principal that is not a user (a service, or an agent acting for one).
 */
export function CurrentUser(): ReturnType<typeof Route> {
  return Route(Parameter('CurrentUserArg'));
}
