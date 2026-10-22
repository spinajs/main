import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import type { AuthnAuditor } from '@spinajs/authn/audit';
import { CredentialChangeBus, IdentityStore, TokenService } from '@spinajs/authn/contracts';
import { Hooks } from '@spinajs/hooks';
import type { ActionHook } from '@spinajs/hooks';
import { kitHooks } from '@spinajs/authn-testing';

import { DbTokenService, TokenProfileHook, TokenProfilePolicy } from '../../src/service/index.js';
import { TokenStrategy } from '../../src/strategy/TokenStrategy.js';

export interface TokenServiceDoubles<T extends DbTokenService> {
  readonly identities: IdentityStore;
  /** Otherwise the registered TokenProfilePolicy. */
  readonly profiles?: TokenProfilePolicy;
  readonly auditor?: AuthnAuditor;
  /** Otherwise the registered CredentialChangeBus. */
  readonly bus?: CredentialChangeBus;
  /** Otherwise a runner of a TokenProfileHook over the service's TokenProfilePolicy and `extraHooks`. */
  readonly hooks?: Hooks;
  readonly extraHooks?: readonly ActionHook[];
  readonly type?: Class<T>;
}

/**
 * Built by DI in a fresh child container, so the injected IdentityStore and profile policy are these doubles. The root
 * runner's TokenProfileHook asks the root's policy, so the service gets its own runner, whose hook asks the child's.
 */
export async function tokenServiceOver<T extends DbTokenService = DbTokenService>(doubles: TokenServiceDoubles<T>): Promise<T> {
  const { identities, profiles, auditor, bus } = doubles;
  const type = doubles.type ?? (DbTokenService as unknown as Class<T>);
  const child = DI.child();
  child.register(() => identities).as(IdentityStore);
  if (profiles) {
    child.register(() => profiles).as(TokenProfilePolicy);
  }
  if (bus) {
    child.register(() => bus).as(CredentialChangeBus);
  }
  const hooks = doubles.hooks ?? (await kitHooks([profileHookIn(child), ...(doubles.extraHooks ?? [])]));
  child.register(() => hooks).as(Hooks);
  // Registered in the child too: DI builds a type in the container that registered it.
  child.register(type).as(type);
  return (await child.resolve(type, auditor ? [auditor] : undefined)) as T;
}

/** A TokenStrategy built with `new` over this TokenService; its `resolve()` is left to the caller. */
export function tokenStrategyOver<T extends TokenStrategy = TokenStrategy>(tokens: TokenService, type: new () => T = TokenStrategy as unknown as new () => T): T {
  const strategy = new type();
  (strategy as unknown as { Tokens: TokenService }).Tokens = tokens;
  return strategy;
}

/** A TokenProfileHook that asks the TokenProfilePolicy `container` resolves. */
export function profileHookIn(container: IContainer): TokenProfileHook {
  return Object.defineProperty(new TokenProfileHook(), 'Container', { value: container });
}
