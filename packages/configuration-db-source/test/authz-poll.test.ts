import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { AuthzService, SYSTEM } from '@spinajs/authz';
import { hostHarness, runBehaviour, testHost } from '@spinajs/authz-testing';

import { asSystem, requireSystemPrincipal, resetSystemPrincipal } from '../src/system.js';
import { bootDb } from './support/db.js';

describe('configuration-db-source under authz', function () {
  this.timeout(10000);

  describe('asSystem', () => {
    afterEach(() => resetSystemPrincipal());

    it('runs the function directly and never touches AuthzService when unguarded', async () => {
      const root = DI.RootContainer;
      const resolve = root.resolve;
      const seen: unknown[] = [];
      root.resolve = ((type: unknown, ...rest: unknown[]) => {
        seen.push(type);
        return (resolve as (...a: unknown[]) => unknown).call(root, type, ...rest);
      }) as typeof root.resolve;
      try {
        expect(await asSystem(async () => 7)).to.equal(7);
        expect(seen).to.not.include(AuthzService);
      } finally {
        root.resolve = resolve;
      }
    });
  });

  describe('poll with a booted authz host', () => {
    before(() => requireSystemPrincipal());

    after(async () => {
      resetSystemPrincipal();
      await testHost.uninstallHost();
    });

    it('waits for the service to resolve, then runs as SYSTEM', async () => {
      let done = false;
      const pending = asSystem(async () => 'ok').then((v) => {
        done = true;
        return v;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(done).to.equal(false);

      await testHost.installHost();
      await DI.resolve(AuthzService);
      expect(await pending).to.equal('ok');
    });

    it("records runAs 'config-poll' and delivers the polled value", async () => {
      const runs: { principal: unknown; reason: string }[] = [];
      const service = (await DI.resolve(AuthzService)) as AuthzService;
      const runAs = service.runAs.bind(service);
      service.runAs = ((principal, reason, fn) => {
        runs.push({ principal, reason });
        return runAs(principal, reason, fn);
      }) as AuthzService['runAs'];

      const db = await bootDb((path, value) => testHost.config().set([...path], value));
      try {
        await db.seed([{ path: 'app.title', value: 'T' }]);
        runs.length = 0;

        await db.poll();

        expect(db.value('app.title')).to.equal('T');
        expect(runs).to.have.length(1);
        expect(runs[0].reason).to.equal('config-poll');
        expect(runs[0].principal).to.equal(SYSTEM);
      } finally {
        service.runAs = runAs;
        await db.dispose();
        testHost.config().reset();
      }
    });
  });
});

runBehaviour(
  ['B09.configuration'],
  () =>
    hostHarness({
      facets: ['configuration'],
      async extend(host) {
        requireSystemPrincipal(host.domain);
        const db = await bootDb((path, value) => host.setConfig(path, value), host.domain);
        await db.seed(host.world.lane?.configuration?.rows ?? []);
        return {
          lane: { configuration: { poll: db.poll, value: db.value } },
          dispose: async () => {
            resetSystemPrincipal();
            await db.dispose();
          },
        };
      },
    }),
  { strict: true },
);
