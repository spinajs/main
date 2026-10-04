import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { AuthzService, DefaultAuthzService, SYSTEM } from '@spinajs/authz';
import { hostHarness, runBehaviour, testHost } from '@spinajs/authz-testing';

import { asSystem } from '../src/system.js';
import { bootDb } from './support/db.js';

describe('configuration-db-source under authz', function () {
  this.timeout(10000);

  describe('asSystem', () => {
    it('runs the function directly when no AuthzService is registered', async () => {
      DI.unregister(DefaultAuthzService);
      try {
        expect(await asSystem(async () => 7)).to.equal(7);
      } finally {
        DI.register(DefaultAuthzService).as(AuthzService);
      }
    });
  });

  describe('poll with a booted authz host', () => {
    before(async () => {
      await testHost.installHost();
    });

    after(async () => {
      await testHost.uninstallHost();
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
        const db = await bootDb((path, value) => host.setConfig(path, value), host.domain);
        await db.seed(host.world.lane?.configuration?.rows ?? []);
        return { lane: { configuration: { poll: db.poll, value: db.value } }, dispose: db.dispose };
      },
    }),
  { strict: true },
);
