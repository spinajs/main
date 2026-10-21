import type { Scenario } from '../lib.js';
import { DENIED, GRANTED, PERMISSIONS, bootRbacHost } from './_authz-host.js';
import type { BenchHost } from './_authz-host.js';

let host: BenchHost;

export default {
  name: 'checkMany.30.warm',
  description: 'AuthzService.checkMany of 30 permissions (20 granted across the role chain, 10 denied), GLOBAL resource, no decision cache',
  iterations: 20_000,
  warmup: 2_000,
  setup: async () => {
    host = await bootRbacHost();
  },
  verify: async () => {
    const res = await host.authz.checkMany(host.alice, PERMISSIONS, host.resource);
    const wrong = PERMISSIONS.filter((p) => res.get(p)?.allowed !== GRANTED.includes(p));
    if (res.size !== PERMISSIONS.length || wrong.length > 0) {
      throw new Error(`expected ${GRANTED.length} granted and ${DENIED.length} denied of ${PERMISSIONS.length}, got ${res.size} decisions, wrong: ${wrong.join(', ')}`);
    }
  },
  teardown: async () => {
    await host?.dispose();
  },
  run: () => host.authz.checkMany(host.alice, PERMISSIONS, host.resource),
} satisfies Scenario;
