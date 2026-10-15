import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  cliParityDriver,
  defineParitySchedules,
  normalizeForParity,
  PARITY_CASES,
  ParityAction,
  ParityDriver,
  runParityCases,
  SchedulerService,
  serviceParityDriver,
  undefineParitySchedules,
} from '../src/index.js';
import { ERROR_GROUP_STATUSES, RUN_STATUSES } from '../src/service/statuses.js';
import { bootTestEnv } from './support/env.js';

const reset = async (): Promise<SchedulerService> => {
  await bootTestEnv({ now: '2026-01-05T10:00:00Z' });
  return DI.resolve(SchedulerService);
};

describe('API / CLI parity', function () {
  this.timeout(120_000);
  before(() => defineParitySchedules());
  after(() => undefineParitySchedules());

  it('every action gives the same normalized result through the service and the CLI', async () => {
    const outcomes = await runParityCases({
      reset,
      drivers: (service) => [serviceParityDriver(service), cliParityDriver()],
    });
    expect(outcomes).to.have.length(PARITY_CASES.length);
    for (const o of outcomes) {
      expect(Object.keys(o.results), o.title).to.deep.eq(['service', 'cli']);
      const [first, ...rest] = Object.values(o.results);
      for (const r of rest) expect(r, o.title).to.deep.eq(first);
      expect(first.ok ? 'ok' : first.code, o.title).to.eq(o.expect);
    }
  });

  it('covers every action and only statuses the CLI accepts', () => {
    const acts = PARITY_CASES.map((c) => c.act({ runId: '00000000-0000-4000-8000-000000000001' }));
    const kinds = new Set(acts.map((a) => a.action));
    const all: Array<ParityAction['action']> = [
      'listSchedules',
      'getSchedule',
      'runNow',
      'listRuns',
      'getRun',
      'cancel',
      'retry',
      'retryFailed',
      'pause',
      'resume',
      'listErrors',
      'setErrorStatus',
      'prune',
    ];
    expect([...kinds].sort()).to.deep.eq([...all].sort());
    for (const a of acts) {
      // the CLI rejects an unknown --status with invalid-params where the service returns an empty list
      if (a.action === 'listRuns' && a.status) expect(RUN_STATUSES).to.include(a.status);
      if ((a.action === 'listErrors' || a.action === 'setErrorStatus') && a.status) {
        expect(ERROR_GROUP_STATUSES).to.include(a.status);
      }
    }
  });

  it('gives every driver of a case fresh state', async () => {
    let resets = 0;
    const counting: ParityDriver = { name: 'count', invoke: async () => ({ ok: true, value: resets }) };
    const outcomes = await runParityCases({
      reset: async () => {
        resets++;
        return reset();
      },
      drivers: (service) => [serviceParityDriver(service), counting],
      cases: [
        {
          title: 'a run created by the first driver is gone for the second',
          act: () => ({ action: 'listRuns', schedule: 'parity-ok' }),
          expect: 'ok',
        },
      ],
    });
    expect(resets).to.eq(2);
    expect(outcomes[0].results.count).to.deep.eq({ ok: true, value: 2 });
  });

  it('normalizes volatile values only', () => {
    expect(
      normalizeForParity({
        id: 'x',
        runIds: ['a'],
        status: 'queued',
        nested: [{ startedAt: 't', triggeredBy: { kind: 'user' }, progress: 5, stack: 's' }],
      }),
    ).to.deep.eq({
      id: '<v>',
      runIds: ['<v>'],
      status: 'queued',
      nested: [{ startedAt: '<v>', triggeredBy: '<v>', progress: 5, stack: '<v>' }],
    });
  });
});
