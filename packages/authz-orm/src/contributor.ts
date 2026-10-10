import { AuthzContributor, engineLog } from '@spinajs/authz';
import type { AuthzContribution, HostLog } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { Injectable, Singleton } from '@spinajs/di';
import { ConnectionState, extractModelDescriptor } from '@spinajs/orm';

import { assertJitOff } from './jit.js';
import { classesOf, entryOf, nameOf, registeredClasses, registeredTypes, uncheckedScopes } from './registry.js';
import type { ModelClass } from './registry.js';

/** Boot rule 6 input: the types whose residuals compile into JOIN ON. */
@Singleton()
@Injectable(AuthzContributor)
export class OrmAuthzContributor extends AuthzContributor {
  private log: HostLog | undefined;
  private readonly warned = new WeakMap<ModelClass, Set<string>>();

  @Config('authz.orm.allowJit')
  protected AllowJit: boolean;

  /** `log` is for tests; DI constructs the class without arguments. */
  constructor(log?: HostLog) {
    super();
    this.log = log;
  }

  async contribute(): Promise<AuthzContribution> {
    this.warnUncheckedScopes();
    await this.checkJit();
    return { joinTypes: registeredTypes().filter((t) => classesOf(t).some((c) => entryOf(c)?.relationScope === 'join')) };
  }

  /** The drivers the orm gave the models so far; a model without one yet is checked at its first query. */
  private async checkJit(): Promise<void> {
    const drivers = new Set(registeredClasses().map((m) => extractModelDescriptor(m as never)?.Driver));
    for (const driver of drivers) {
      // A disposed connection (a test's, or one replaced at runtime) cannot answer; its next query would fail anyway.
      if (driver == null || driver.State === ConnectionState.Disconnected) continue;
      await assertJitOff(driver, () => this.AllowJit);
    }
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
