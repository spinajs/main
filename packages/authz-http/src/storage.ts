import type { IAuthnPrincipalStorage, IAuthzAsyncStorage } from '@spinajs/authz';

/** Left by AccessPolicy for the field filters, which run without the controller: the route's @Access domain and opt-out. */
export interface AuthzHttpRouteMark {
  readonly domain: string;
  readonly unfilteredInput?: string;
}

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext extends IAuthzAsyncStorage, IAuthnPrincipalStorage {
    AuthzHttpRoute?: AuthzHttpRouteMark;
  }
}
