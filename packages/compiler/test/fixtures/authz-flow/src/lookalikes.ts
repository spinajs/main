import { SYSTEM as FRAMEWORK_SYSTEM, authz } from '@spinajs/authz';

/** Not the framework's system principal: an app's own constant of the same name and type. */
export const SYSTEM: typeof FRAMEWORK_SYSTEM = Object.freeze({ ...FRAMEWORK_SYSTEM });

/** Not the framework's runAs: an app's own method of the same name and shape. */
export class Impersonation {
  async runAs<T>(_principal: typeof FRAMEWORK_SYSTEM, _reason: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/** Reached from no entry point, so it adds no system run to any whole-fixture expectation. */
export class Lookalikes {
  constructor(private readonly own: Impersonation) {}

  ownRunAs() {
    return this.own.runAs(FRAMEWORK_SYSTEM, 'lookalike', async () => 1);
  }
  ownSystem() {
    return authz().runAs(SYSTEM, 'lookalike', async () => 1);
  }
  real() {
    return authz().runAs(FRAMEWORK_SYSTEM, 'lookalike', async () => 1);
  }
}
