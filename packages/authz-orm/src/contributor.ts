import { AuthzContributor, engineLog } from '@spinajs/authz';
import type { AuthzContribution, HostLog } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { classesOf, entryOf, nameOf, registeredTypes, uncheckedScopes } from './registry.js';
import type { ModelClass } from './registry.js';

/** Boot rule 6 input: the types whose residuals compile into JOIN ON. */
@Singleton()
@Injectable(AuthzContributor)
export class OrmAuthzContributor extends AuthzContributor {
  private log: HostLog | undefined;
  private readonly warned = new WeakMap<ModelClass, Set<string>>();

  /** `log` is for tests; DI constructs the class without arguments. */
  constructor(log?: HostLog) {
    super();
    this.log = log;
  }

  contribute(): AuthzContribution {
    this.warnUncheckedScopes();
    return { joinTypes: registeredTypes().filter((t) => classesOf(t).some((c) => entryOf(c)?.relationScope === 'join')) };
  }

  // Decorators run in any order and registerAccessResource may come later, so this waits for boot.
  private warnUncheckedScopes(): void {
    for (const { model, relation, policy } of uncheckedScopes()) {
      const relations = this.warned.get(model) ?? new Set<string>();
      if (relations.has(relation)) continue;
      relations.add(relation);
      this.warned.set(model, relations);
      const name = nameOf(model);
      (this.log ??= engineLog('authz-orm')).warn(`authz-orm: @OrmScope(${name}, '${relation}') names ${nameOf(policy)}, which is never applied: ${name} has no @AccessResource, so its queries are not checked`);
    }
  }
}
