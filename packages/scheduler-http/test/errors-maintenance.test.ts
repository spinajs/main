import 'mocha';
import { expect } from 'chai';
import { ErrorGroupNotFound, httpStatusForError, InvalidRunParams, InvalidRunState, RunConflict, RunNotFound, ScheduleNotFound, SchedulePaused } from '@spinajs/scheduler';

import { asRole, bootHttp, req, stopHttp, TEST_USER_UUID } from './common.js';
import { FakeSchedulerService, makeErrorGroup, makeSchedule, RUN_ID, SCHEDULE_NAME } from './fakes/fake-scheduler.js';

describe('scheduler-http: errors and maintenance', function () {
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
    fake.errors = [makeErrorGroup()];
  });

  describe('GET /scheduler/errors', () => {
    it('lists error groups with filters', async () => {
      const res = await req().get('scheduler/errors').query({ schedule: SCHEDULE_NAME, status: 'open' }).set(asRole('scheduler-reader'));

      expect(res).to.have.status(200);
      expect(res.body).to.deep.equal([makeErrorGroup()]);
      expect(fake.callsTo('listErrors')[0][0]).to.deep.equal({ schedule: SCHEDULE_NAME, status: 'open' });
    });

    it('sends no filter fields that were not given', async () => {
      await req().get('scheduler/errors').set(asRole('scheduler-reader'));

      expect(fake.callsTo('listErrors')[0][0]).to.deep.equal({});
    });

    it('answers 400 to an unknown status filter', async () => {
      const res = await req().get('scheduler/errors').query({ status: 'closed' }).set(asRole('scheduler-reader'));
      expect(res).to.have.status(400);
    });
  });

  describe('PATCH /scheduler/errors/:fingerprint', () => {
    it('changes the status of a group', async () => {
      const res = await req().patch('scheduler/errors/f00dfeed').set(asRole('scheduler-admin')).send({ status: 'resolved' });

      expect(res).to.have.status(200);
      expect(res.body.status).to.eq('resolved');

      const [fingerprint, status, ctx] = fake.callsTo('setErrorStatus')[0] as [string, string, any];
      expect([fingerprint, status]).to.deep.equal(['f00dfeed', 'resolved']);
      expect(ctx.triggeredBy.id).to.eq(TEST_USER_UUID);
    });

    it('answers 404 for an unknown fingerprint ( ErrorGroupNotFound )', async () => {
      const res = await req().patch('scheduler/errors/deadbeef').set(asRole('scheduler-admin')).send({ status: 'ignored' });
      expect(res).to.have.status(404);
    });

    it('answers 400 to a missing or unknown status', async () => {
      const missing = await req().patch('scheduler/errors/f00dfeed').set(asRole('scheduler-admin')).send({});
      const unknown = await req().patch('scheduler/errors/f00dfeed').set(asRole('scheduler-admin')).send({ status: 'closed' });

      expect(missing).to.have.status(400);
      expect(unknown).to.have.status(400);
    });

    it('requires the manage tier', async () => {
      const res = await req().patch('scheduler/errors/f00dfeed').set(asRole('scheduler-operator')).send({ status: 'resolved' });
      expect(res).to.have.status(403);
    });
  });

  describe('POST /scheduler/prune', () => {
    it('prunes and returns the removed counts', async () => {
      const res = await req().post('scheduler/prune').set(asRole('scheduler-admin'));

      expect(res).to.have.status(200);
      expect(res.body).to.deep.equal({ orphanedSchedules: 0, runs: 3, logs: 10, errors: 1 });
      expect((fake.callsTo('prune')[0][0] as any).triggeredBy.kind).to.eq('user');
    });

    it('requires the manage tier', async () => {
      const res = await req().post('scheduler/prune').set(asRole('scheduler-operator'));
      expect(res).to.have.status(403);
    });
  });

  describe('service errors follow httpStatusForError', () => {
    const samples: Array<[string, Error, number]> = [
      ['ScheduleNotFound', new ScheduleNotFound(SCHEDULE_NAME), 404],
      ['RunNotFound', new RunNotFound(RUN_ID), 404],
      ['ErrorGroupNotFound', new ErrorGroupNotFound('deadbeef'), 404],
      ['RunConflict', new RunConflict('busy', RUN_ID), 409],
      ['InvalidRunParams', new InvalidRunParams('bad params', [{ path: '/file', message: 'must be string' }]), 400],
      ['InvalidRunState', new InvalidRunState('ended', 'succeeded'), 409],
      ['SchedulePaused', new SchedulePaused(SCHEDULE_NAME), 409],
      ['Error', new Error('unexpected'), 500],
    ];

    for (const [name, err, expected] of samples) {
      it(`${name} answers ${expected}`, async () => {
        fake.failWith = err;

        const res = await req().get('scheduler/schedules').set(asRole('scheduler-reader'));

        expect(httpStatusForError(err)).to.eq(expected);
        expect(res).to.have.status(expected);
      });
    }
  });
});
