import 'mocha';
import { expect } from 'chai';

import { asRole, bootHttp, req, stopHttp } from './common.js';
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
});
