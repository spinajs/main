import 'mocha';
import { expect } from 'chai';

import { InvalidRunState, RunNotFound } from '@spinajs/scheduler';

import { asRole, bootHttp, req, stopHttp, TEST_USER_UUID } from './common.js';
import { FakeSchedulerService, makeRun, OTHER_RUN_ID, RUN_ID, SCHEDULE_NAME } from './fakes/fake-scheduler.js';

describe('scheduler-http: runs', function () {
  this.timeout(25000);

  let fake: FakeSchedulerService;

  before(async () => {
    fake = await bootHttp();
  });

  after(async () => {
    await stopHttp();
  });

  beforeEach(() => {
    fake.reset();
    fake.runs.set(RUN_ID, makeRun());
    fake.runs.set(OTHER_RUN_ID, makeRun({ id: OTHER_RUN_ID, status: 'failed' }));
  });

  describe('GET /scheduler/runs', () => {
    it('returns the service page with the default limit', async () => {
      const res = await req().get('scheduler/runs').set(asRole('scheduler-reader'));

      expect(res).to.have.status(200);
      expect(res.body).to.containSubset({ total: 2, limit: 50, offset: 0 });
      expect(res.body.items).to.have.lengthOf(2);
      expect(fake.callsTo('listRuns')[0][0]).to.deep.equal({ limit: 50, offset: 0 });
    });

    it('passes filters and pagination to the service unchanged', async () => {
      const res = await req()
        .get('scheduler/runs')
        .query({ schedule: SCHEDULE_NAME, status: 'failed', trigger: 'manual', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', limit: 1, offset: 1 })
        .set(asRole('scheduler-reader'));

      expect(res).to.have.status(200);
      expect(fake.callsTo('listRuns')[0][0]).to.deep.equal({
        schedule: SCHEDULE_NAME,
        status: 'failed',
        trigger: 'manual',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        limit: 1,
        offset: 1,
      });
      expect(res.body.items.map((r: any) => r.id)).to.deep.equal([OTHER_RUN_ID]);
    });

    it('answers 400 to an unknown status', async () => {
      const res = await req().get('scheduler/runs').query({ status: 'exploded' }).set(asRole('scheduler-reader'));
      expect(res).to.have.status(400);
    });

    it('answers 400 to a page size above 500 or a negative offset', async () => {
      const big = await req().get('scheduler/runs').query({ limit: 501 }).set(asRole('scheduler-reader'));
      const negative = await req().get('scheduler/runs').query({ offset: -1 }).set(asRole('scheduler-reader'));

      expect(big).to.have.status(400);
      expect(negative).to.have.status(400);
    });

    it('answers 400 to a malformed date', async () => {
      const res = await req().get('scheduler/runs').query({ from: 'last week' }).set(asRole('scheduler-reader'));
      expect(res).to.have.status(400);
    });

    it('answers 403 to a role without scheduler grants', async () => {
      const res = await req().get('scheduler/runs').set(asRole('nobody'));
      expect(res).to.have.status(403);
    });
  });

  describe('GET /scheduler/runs/:id', () => {
    it('returns the run', async () => {
      const res = await req().get(`scheduler/runs/${RUN_ID}`).set(asRole('scheduler-reader'));

      expect(res).to.have.status(200);
      expect(res.body).to.containSubset({ id: RUN_ID, status: 'running', steps: [], attempts: [] });
    });

    it('answers 404 for an unknown run', async () => {
      const res = await req().get('scheduler/runs/33333333-3333-4333-8333-333333333333').set(asRole('scheduler-reader'));
      expect(res).to.have.status(404);
    });

    it('answers 400 to a malformed run id', async () => {
      const res = await req().get('scheduler/runs/not-a-uuid').set(asRole('scheduler-reader'));

      expect(res).to.have.status(400);
      expect(fake.callsTo('getRun')).to.be.empty;
    });
  });

  describe('POST /scheduler/runs/:id/cancel', () => {
    it('requests cancellation and answers 202 with the run', async () => {
      const res = await req().post(`scheduler/runs/${RUN_ID}/cancel`).set(asRole('scheduler-operator'));

      expect(res).to.have.status(202);
      expect(res.body).to.containSubset({ id: RUN_ID, cancelRequested: true });

      const [id, ctx] = fake.callsTo('cancel')[0] as [string, any];
      expect(id).to.eq(RUN_ID);
      expect(ctx.triggeredBy.id).to.eq(TEST_USER_UUID);
    });

    it('cancels an emitted run, which has not ended yet', async () => {
      fake.runs.set(RUN_ID, makeRun({ status: 'emitted' }));

      const res = await req().post(`scheduler/runs/${RUN_ID}/cancel`).set(asRole('scheduler-operator'));

      expect(res).to.have.status(202);
      expect(res.body).to.containSubset({ status: 'emitted', cancelRequested: true });
    });

    it('answers 409 when the run already ended', async () => {
      fake.failWith = new InvalidRunState('run already ended', 'succeeded');

      const res = await req().post(`scheduler/runs/${OTHER_RUN_ID}/cancel`).set(asRole('scheduler-operator'));

      expect(res).to.have.status(409);
    });

    it('answers 404 for an unknown run', async () => {
      fake.failWith = new RunNotFound('33333333-3333-4333-8333-333333333333');

      const res = await req().post('scheduler/runs/33333333-3333-4333-8333-333333333333/cancel').set(asRole('scheduler-operator'));

      expect(res).to.have.status(404);
    });

    it('answers 403 to a reader', async () => {
      const res = await req().post(`scheduler/runs/${RUN_ID}/cancel`).set(asRole('scheduler-reader'));
      expect(res).to.have.status(403);
    });
  });

  describe('POST /scheduler/runs/:id/retry', () => {
    it('queues a retry and answers 202 with the new run id', async () => {
      const res = await req()
        .post(`scheduler/runs/${OTHER_RUN_ID}/retry`)
        .set(asRole('scheduler-operator'))
        .send({ fromStep: 'poll forges', resume: true, params: { file: 'b.csv' } });

      expect(res).to.have.status(202);
      expect(res.body).to.deep.equal({ runId: OTHER_RUN_ID });

      const [id, options] = fake.callsTo('retry')[0] as [string, any];
      expect(id).to.eq(OTHER_RUN_ID);
      expect(options).to.deep.include({ fromStep: 'poll forges', resume: true, params: { file: 'b.csv' } });
      expect(options.triggeredBy.kind).to.eq('user');
    });

    it('leaves resume to the schedule when it is not sent', async () => {
      const res = await req().post(`scheduler/runs/${OTHER_RUN_ID}/retry`).set(asRole('scheduler-operator'));

      expect(res).to.have.status(202);
      expect(fake.callsTo('retry')[0][1]).to.not.have.property('resume');
    });

    it('answers 409 for a run that cannot be retried', async () => {
      fake.failWith = new InvalidRunState('only failed, dead and aborted runs can be retried', 'running');

      const res = await req().post(`scheduler/runs/${RUN_ID}/retry`).set(asRole('scheduler-operator')).send({});

      expect(res).to.have.status(409);
    });

    it('answers 400 to an invalid body', async () => {
      const res = await req().post(`scheduler/runs/${OTHER_RUN_ID}/retry`).set(asRole('scheduler-operator')).send({ fromStep: '' });
      expect(res).to.have.status(400);
    });
  });
});
