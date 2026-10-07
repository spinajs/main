import 'mocha';
import { expect } from 'chai';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { configuredChild, violationPaths } from '../behaviour/harness.js';

// Ajv evaluates the `if` on the raw value, before `properties` coerces 'true' or 1 into true.
describe('authn.mfa.policy.force needs a step, whatever spelling coerces to true', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  for (const force of [true, 'true', 1, '1']) {
    it(`refuses force ${JSON.stringify(force)} without steps at boot`, async () => {
      expect(await violationPaths(configuredChild({ authn: { mfa: { policy: { force } } } }, 'test', true))).to.include('authn.mfa.steps');
    });
  }

  for (const force of [false, 'false', 0]) {
    it(`takes force ${JSON.stringify(force)} without steps`, async () => {
      const child = await configuredChild({ authn: { mfa: { policy: { force } } } }, 'test', true);
      children.push(child);
      expect(child.get(Configuration)!.get('authn.mfa.policy.force')).to.eq(false);
    });
  }
});
