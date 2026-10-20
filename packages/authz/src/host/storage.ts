import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import type { Decision } from '../contracts/decision.js';
import { UNATTENDED } from '../contracts/principal.js';
import type { Principal } from '../contracts/principal.js';
import type { RequestScope } from '../engine/authorizer.js';

/** Keys authz keeps in the request store it shares with http; other keys stay untouched. */
export interface IAuthzAsyncStorage {
  Principal?: Principal;
  AuthzCache?: Map<string, unknown>;
  AuthzDecision?: Decision;
  Unscoped?: string;
}

type AuthzStore = IAuthzAsyncStorage & Record<string, unknown>;

// Resolved on every call, never cached: see packages/log/src/context.ts.
export function authzStorage(): AsyncLocalStorage<AuthzStore> {
  return DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<AuthzStore>;
}

export function currentPrincipal(): Principal {
  const p = authzStorage().getStore()?.Principal;
  return p !== null && typeof p === 'object' ? p : UNATTENDED;
}

export function requestScope(): RequestScope {
  const store = authzStorage().getStore();
  if (store === undefined) return { cache: new Map() };
  if (!(store.AuthzCache instanceof Map)) store.AuthzCache = new Map();
  return { cache: store.AuthzCache };
}

export function runWithPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  // The route's decision and @Unscoped belong to the outer principal, so they do not carry over.
  const { AuthzDecision: _decision, Unscoped: _unscoped, ...rest } = authzStorage().getStore() ?? {};
  const store: AuthzStore = { ...rest, Principal: principal, AuthzCache: new Map() };
  return authzStorage().run(store, async () => fn());
}
