import type { Scenario } from '../lib.js';
import { bootRbacHost } from './_authz-host.js';
import type { BenchHost } from './_authz-host.js';

let host: BenchHost;

// item:op00 lives in the bottom role of the 4-role chain, so the check walks all 3 $extend levels.
const PERMISSION = 'item:op00';
const UNGRANTED = 'item:op29';

export default {
  name: 'check.warm',
  description: 'AuthzService.check, admin over a 4-role chain (3 $extend levels), GLOBAL resource, no decision cache',
  iterations: 100_000,
  warmup: 10_000,
  setup: async () => {
    host = await bootRbacHost();
  },
  verify: async () => {
    const granted = await host.authz.check({ principal: host.alice, permission: PERMISSION, resource: host.resource });
    const denied = await host.authz.check({ principal: host.alice, permission: UNGRANTED, resource: host.resource });
    if (!granted.allowed || denied.allowed) {
      throw new Error(`expected ${PERMISSION} allowed and ${UNGRANTED} denied, got ${granted.allowed} and ${denied.allowed}`);
    }
  },
  teardown: async () => {
    await host?.dispose();
  },
  run: () => host.authz.check({ principal: host.alice, permission: PERMISSION, resource: host.resource }),
} satisfies Scenario;
