import { InvalidArgument } from '@spinajs/exceptions';
import { Parameter, ParameterType, Route, RouteArgs } from '@spinajs/http';
import type { IRouteArgsResult, IRouteCall, IRouteParameter, Request } from '@spinajs/http';

import type { AuthnIdentity } from '../api.js';

// Not named like the 2.x SessionArg, SessionIdArg, ...: DI keys classes by name (N8a-D2). @spinajs/http resolves a route
// arg by this name from the root container; registerAuthnHttpV3 registers them there.

/**
 * Resolves to the AuthnIdentity of req.storage.AuthnPrincipal, or null without a principal (a pending session gives null).
 * Like Authenticated, it counts a principal only when `authenticated` is true.
 */
export class AuthnIdentityArg extends RouteArgs {
  public get SupportedType(): string {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    const principal = req.storage.AuthnPrincipal;
    const identity: AuthnIdentity | null = principal?.authenticated === true && principal.authn ? { identity: { type: principal.type, id: principal.id }, facts: principal.authn } : null;
    return { CallData: callData, Args: identity };
  }
}

/** Resolves to the SessionHandle of req.storage.AuthnSession, pending included, or null. Not authentication: check handle.state. */
export class AuthnSessionArg extends RouteArgs {
  public get SupportedType(): string {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    return { CallData: callData, Args: req.storage.AuthnSession?.handle ?? null };
  }
}

/** Resolves to the raw id of the restored session (pending included, so not authentication), or null. Never log or return it. */
export class AuthnSessionIdArg extends RouteArgs {
  public get SupportedType(): string {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    return { CallData: callData, Args: req.storage.AuthnSession?.handle.id ?? null };
  }
}

/** Resolves to the value under the parameter's `key` in the restored session's data, or undefined. Pending sessions included. */
export class AuthnSessionDataArg extends RouteArgs {
  public get SupportedType(): string {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    const key = (param.Options as { key?: unknown } | undefined)?.key;
    return { CallData: callData, Args: typeof key === 'string' ? req.storage.AuthnSession?.data.get(key) : undefined };
  }
}

/** Resolves to the AuthnIdentity of req.storage.AuthnPrincipal, or null without a principal (a pending session gives null). */
export function Identity(): ReturnType<typeof Route> {
  return Route(Parameter('AuthnIdentityArg'));
}

/** Resolves to the SessionHandle of req.storage.AuthnSession, pending included (the MFA routes need it), or null. Not authentication: check handle.state. */
export function AuthnSession(): ReturnType<typeof Route> {
  return Route(Parameter('AuthnSessionArg'));
}

/**
 * Resolves to the raw id of the restored session (pending included, so not authentication), or null; an unknown or expired cookie
 * gives null. Reads req.storage.AuthnSession, never the cookie. Never log or return it.
 */
export function SessionId(): ReturnType<typeof Route> {
  return Route(Parameter('AuthnSessionIdArg'));
}

/**
 * Resolves to the value stored under `key` in the restored session's data (SessionIssuer.set), or undefined without a session or key.
 * Pending sessions included, so not authentication.
 */
export function FromSession(key: string): ReturnType<typeof Route> {
  if (typeof key !== 'string' || key === '') throw new InvalidArgument('FromSession needs a non-empty session data key');
  return Route(Parameter('AuthnSessionDataArg', undefined, { key }));
}
