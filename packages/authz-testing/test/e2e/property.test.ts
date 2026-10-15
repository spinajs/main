import 'mocha';
import * as fc from 'fast-check';

import { arb, laneSteps } from '@spinajs/authz-testing';
import type { HarnessSession, SetupContext, StepContext } from '@spinajs/authz-testing';

import { E2E_DIALECTS, e2eHarness, withPostgres } from './support/stack.js';

const NUM_RUNS = Number(process.env.E2E_PROPERTY_RUNS ?? 25);

for (const kind of E2E_DIALECTS) {
  describe(`e2e property: .accessible() and .withAccess ⇔ checkAll (${kind})`, function () {
    this.timeout(600_000);
    const harness = e2eHarness(kind);

    before(async function () {
      await withPostgres(this, kind);
      await harness.beforeAll?.();
    });
    after(() => harness.afterAll?.());

    it('holds for random worlds', async () => {
      let n = 0;
      await fc.assert(
        fc.asyncProperty(arb.accessWorld(), async ({ world, users }) => {
          const title = `property ${++n}`;
          const session: HarnessSession = await harness.setup(world, { id: 'B06', part: 'accessible', case: title, title, facets: ['engine', 'rbac', 'orm'] } as SetupContext);
          try {
            // accessibleAgree reads only session, authz and principal.
            const ctx = {
              session,
              world,
              domain: session.domain ?? 'root',
              authz: () => session.authz,
              principal: (who: unknown) => (typeof who === 'string' ? world.principals![who] : who),
            } as unknown as StepContext;
            for (const [model, type, permissions] of [
              ['Doc', 'doc', ['doc:read', 'doc:update']],
              ['Project', 'project', ['project:read']],
            ] as const) {
              await laneSteps.accessibleAgree({ as: users, permissions, model, type }).do(ctx);
            }
          } finally {
            await session.dispose();
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
}
