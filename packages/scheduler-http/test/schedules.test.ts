import 'mocha';
import { expect } from 'chai';

import { asRole, bootHttp, JSON_HEADERS, req, stopHttp } from './common.js';
import { FakeSchedulerService, makeSchedule, SCHEDULE_NAME } from './fakes/fake-scheduler.js';

describe('scheduler-http: schedules', function () {
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
    fake.schedules = [makeSchedule()];
  });

  describe('authorization', () => {
    it('answers 401 to an anonymous request', async () => {
      const res = await req().get('scheduler/schedules').set(JSON_HEADERS);
      expect(res).to.have.status(401);
    });

    it('answers 403 to a role without scheduler grants', async () => {
      const res = await req().get('scheduler/schedules').set(asRole('nobody'));

      expect(res).to.have.status(403);
      expect(fake.calls).to.be.empty;
    });
  });

  describe('GET /scheduler/schedules', () => {
    it('lists schedules for a reader', async () => {
      const res = await req().get('scheduler/schedules').set(asRole('scheduler-reader'));

      expect(res).to.have.status(200);
      expect(res.body).to.deep.equal([makeSchedule()]);
    });
  });

  describe('GET /scheduler/schedules/:name', () => {
    it('returns the schedule with recent runs and open errors', async () => {
      const res = await req().get(`scheduler/schedules/${SCHEDULE_NAME}`).set(asRole('scheduler-reader'));

      expect(res).to.have.status(200);
      expect(res.body).to.containSubset({ name: SCHEDULE_NAME, recentRuns: [], openErrors: [] });
    });

    it('answers 404 for an unknown schedule', async () => {
      const res = await req().get('scheduler/schedules/nope').set(asRole('scheduler-reader'));
      expect(res).to.have.status(404);
    });
  });
});
