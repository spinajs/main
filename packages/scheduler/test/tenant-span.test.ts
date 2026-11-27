import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';
import { defineSchedule, Scheduler, ScheduledTask, ScheduleModel, undefineSchedule } from '../src/index.js';
import type { FakeClock } from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { queuedRun } from './support/fixtures.js';

class Spanned extends ScheduledTask {
  public execute() {
    return Promise.resolve(null);
  }
}

describe('the run span of a tenant instance', () => {
  let clock: FakeClock;
  let spans: InMemorySpans;

  beforeEach(async () => {
    spans = useInMemorySpans();
    defineSchedule(Spanned, 'spanned', { manual: true });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
  });

  afterEach(async () => {
    undefineSchedule('spanned');
    await spans.detach();
  });

  after(() => resetTracing());

  it('carries spina.tenant.id from the run row, and a global run none', async () => {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await ScheduleModel.create({
      Name: 'spanned',
      Tenant: 'acme',
      Definition: {},
      DefinitionHash: 'h',
      NextRunAt: null,
      Paused: false,
      HardPaused: false,
      ConsecutiveFailures: 0,
      Orphaned: false,
      UpdatedAt: 0,
    });
    await queuedRun('spanned', clock.now(), { Tenant: 'acme' });
    await queuedRun('spanned', clock.now() + 1);

    await s.tickOnce();
    await s.idle();

    expect(spans.byName('run spanned').map((x) => x.attributes['spina.tenant.id'])).to.have.members([
      'acme',
      undefined,
    ]);
  });
});
