import type { IAuthnPrincipalStorage, IAuthzAsyncStorage } from '@spinajs/authz';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext extends IAuthzAsyncStorage, IAuthnPrincipalStorage {}
}

export {};
