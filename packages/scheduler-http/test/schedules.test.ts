import 'mocha';
import { expect } from 'chai';

import { httpStatusForError, InvalidRunParams, RunConflict, ScheduleNotFound, SchedulePaused } from '@spinajs/scheduler';

import { asRole, bootHttp, JSON_HEADERS, req, stopHttp, TEST_USER_UUID } from './common.js';
import { FakeSchedulerService, makeRun, makeSchedule, RUN_ID, SCHEDULE_NAME } from './fakes/fake-scheduler.js';

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

  describe('POST /scheduler/schedules/:name/runs', () => {
    const url = `scheduler/schedules/${SCHEDULE_NAME}/runs`;

    it('queues a manual run and answers 202 with its id', async () => {
      const res = await req().post(url).set(asRole('scheduler-operator')).send({ params: { file: 'rates.csv' } });

      expect(res).to.have.status(202);
      expect(res.body).to.deep.equal({ runId: RUN_ID });

      const [name, options] = fake.callsTo('runNow')[0] as [string, any];
      expect(name).to.eq(SCHEDULE_NAME);
      expect(options).to.deep.equal({
        params: { file: 'rates.csv' },
        force: false,
        wait: false,
        triggeredBy: { kind: 'user', id: TEST_USER_UUID, name: 'tester' },
      });
    });

    it('accepts a request without a body', async () => {
      const res = await req().post(url).set(asRole('scheduler-operator'));

      expect(res).to.have.status(202);
      expect((fake.callsTo('runNow')[0][1] as any).force).to.eq(false);
    });

    it('records api-token callers as token principals', async () => {
      await req().post(url).set(asRole('scheduler-operator', { 'x-test-token': 'tok-1' })).send({});

      expect((fake.callsTo('runNow')[0][1] as any).triggeredBy.kind).to.eq('token');
    });

    it('passes force and wait through', async () => {
      await req().post(url).set(asRole('scheduler-operator')).send({ force: true, wait: true });

      expect(fake.callsTo('runNow')[0][1]).to.include({ force: true, wait: true });
    });

    it('answers 200 with the run when the service waited for it', async () => {
      fake.runNowResult = { runId: RUN_ID, run: makeRun({ status: 'succeeded' }) };

      const res = await req().post(url).set(asRole('scheduler-operator')).send({ wait: true });

      expect(res).to.have.status(200);
      expect(res.body.runId).to.eq(RUN_ID);
      expect(res.body.run.status).to.eq('succeeded');
    });

    it('answers 409 with the id of the blocking run', async () => {
      const err = new RunConflict(`a run of ${SCHEDULE_NAME} is in progress`, RUN_ID);
      fake.failWith = err;

      const res = await req().post(url).set(asRole('scheduler-operator')).send({});

      expect(res).to.have.status(409);
      expect(res.status).to.eq(httpStatusForError(err));
      expect(res.body.runId).to.eq(RUN_ID);
    });

    it('answers 400 with the param errors when params do not match the schedule schema', async () => {
      const err = new InvalidRunParams('invalid params', [{ path: '/file', message: 'must be string' }]);
      fake.failWith = err;

      const res = await req().post(url).set(asRole('scheduler-operator')).send({ params: { file: 1 } });

      expect(res).to.have.status(400);
      expect(res.status).to.eq(httpStatusForError(err));
      expect(res.body.errors).to.deep.equal([{ path: '/file', message: 'must be string' }]);
    });

    it('answers 409 when the schedule is hard-paused', async () => {
      const err = new SchedulePaused(SCHEDULE_NAME);
      fake.failWith = err;

      const res = await req().post(url).set(asRole('scheduler-operator')).send({});

      expect(res).to.have.status(409);
      expect(res.status).to.eq(httpStatusForError(err));
    });

    it('answers 404 for an unknown schedule', async () => {
      fake.failWith = new ScheduleNotFound('nope');

      const res = await req().post('scheduler/schedules/nope/runs').set(asRole('scheduler-operator')).send({});

      expect(res).to.have.status(404);
    });

    it('answers 400 to an invalid body without calling the service', async () => {
      const res = await req().post(url).set(asRole('scheduler-operator')).send({ forse: true });

      expect(res).to.have.status(400);
      expect(fake.callsTo('runNow')).to.be.empty;
    });

    it('answers 403 to a reader', async () => {
      const res = await req().post(url).set(asRole('scheduler-reader')).send({});

      expect(res).to.have.status(403);
      expect(fake.callsTo('runNow')).to.be.empty;
    });
  });
});
