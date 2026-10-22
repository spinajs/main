import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { HttpServer } from '@spinajs/http';

import { asRole, bootHttp, req, stopHttp } from './common.js';
import { eventually, events, openSse } from './sse-client.js';
import { FakeSchedulerService, makeRun, makeSchedule, OTHER_RUN_ID, progressEvent, RUN_ID, SCHEDULE_NAME, statusEvent, stepStartEvent } from './fakes/fake-scheduler.js';

const reader = { 'x-test-role': 'scheduler-reader' };
const runPath = `/scheduler/runs/${RUN_ID}/events`;
const schedulePath = `/scheduler/schedules/${SCHEDULE_NAME}/events`;
const unknownRunPath = '/scheduler/runs/33333333-3333-4333-8333-333333333333/events';

describe('scheduler-http: SSE endpoints', function () {
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
    fake.runs.set(RUN_ID, makeRun());
    fake.events = [statusEvent(1, 'running'), stepStartEvent(2, 'load')];
  });

  describe('GET /scheduler/runs/:id/events', () => {
    it('opens an uncompressed stream with the run history followed by live events', async () => {
      const conn = await openSse(runPath, { ...reader, 'Accept-Encoding': 'gzip' });

      expect(conn.status).to.eq(200);
      expect(conn.headers['content-type']).to.eq('text/event-stream; charset=utf-8');
      expect(conn.headers['content-encoding']).to.eq(undefined);

      await conn.waitFor((f) => events(f).length === 2);
      fake.emit(progressEvent(3, 50));
      const frames = events(await conn.waitFor((f) => events(f).length === 3));

      expect(frames.map((f) => f.id)).to.deep.equal(['1', '2', '3']);
      expect(frames.map((f) => f.event)).to.deep.equal(['status', 'step-start', 'progress']);
      expect(JSON.parse(frames[2].data!)).to.deep.equal(progressEvent(3, 50));
      conn.close();
    });

    it('replays only what follows Last-Event-ID', async () => {
      fake.events.push(progressEvent(3, 50));

      const conn = await openSse(runPath, { ...reader, 'Last-Event-ID': '2' });
      const frames = events(await conn.waitFor((f) => events(f).length >= 1));

      expect(frames.map((f) => f.id)).to.deep.equal(['3']);
      conn.close();
    });

    it('ends the stream after the terminal status and unsubscribes', async () => {
      const conn = await openSse(runPath, reader);
      await conn.waitFor((f) => events(f).length === 2);

      fake.emit(statusEvent(3, 'succeeded'));
      await conn.ended;

      expect(events(conn.frames).map((f) => f.event)).to.deep.equal(['status', 'step-start', 'status']);
      expect(fake.activeSubscriptions).to.eq(0);
    });

    it('keeps the stream open through retrying and ends it after the final status', async () => {
      const conn = await openSse(runPath, reader);
      await conn.waitFor((f) => events(f).length === 2);

      fake.emit(statusEvent(3, 'retrying'));
      fake.emit({ ...statusEvent(4, 'running'), attempt: 2 });
      await conn.waitFor((f) => events(f).length === 4);
      expect(fake.activeSubscriptions).to.eq(1);

      fake.emit({ ...statusEvent(5, 'failed'), attempt: 2 });
      await conn.ended;

      expect(events(conn.frames).map((f) => (JSON.parse(f.data!) as { status?: string }).status ?? f.event)).to.deep.equal(['running', 'step-start', 'retrying', 'running', 'failed']);
      expect(fake.activeSubscriptions).to.eq(0);
    });

    it('unsubscribes when the client disconnects', async () => {
      const conn = await openSse(runPath, reader);
      await conn.waitFor((f) => events(f).length === 2);
      expect(fake.activeSubscriptions).to.eq(1);

      conn.close();

      await eventually(() => fake.activeSubscriptions === 0);
    });

    it('sends the heartbeat comment at the configured interval', async () => {
      const conn = await openSse(runPath, reader);

      await conn.waitFor((f) => f.some((frame) => frame.comment === 'ping'), 2000);
      conn.close();
    });

    it('answers 404 as JSON for an unknown run when JSON is acceptable', async () => {
      const res = await req()
        .get(unknownRunPath.slice(1))
        .set({ ...reader, Accept: 'text/event-stream, application/json;q=0.5' });

      expect(res).to.have.status(404);
      expect(fake.subscriptions).to.eq(0);
    });

    it('answers 406 to an error for a client that accepts only text/event-stream', async () => {
      const conn = await openSse(unknownRunPath, reader);

      expect(conn.status).to.eq(406);
      conn.close();
    });

    it('answers 400 to a malformed Last-Event-ID', async () => {
      const res = await req().get(runPath.slice(1)).set({ ...asRole('scheduler-reader'), 'Last-Event-ID': 'abc' });
      expect(res).to.have.status(400);
    });

    it('answers 401 and 403 before opening a stream', async () => {
      const anonymous = await req().get(runPath.slice(1)).set({ Accept: 'application/json' });
      const nobody = await req().get(runPath.slice(1)).set(asRole('nobody'));

      expect(anonymous).to.have.status(401);
      expect(nobody).to.have.status(403);
      expect(fake.subscriptions).to.eq(0);
    });
  });

  describe('GET /scheduler/schedules/:name/events', () => {
    it('streams live events of all runs of the schedule with global ids', async () => {
      const conn = await openSse(schedulePath, reader);
      await eventually(() => fake.activeSubscriptions === 1);

      fake.emit(statusEvent(1, 'running', OTHER_RUN_ID, 101));
      fake.emit(statusEvent(3, 'succeeded', RUN_ID, 102));
      fake.emit(progressEvent(2, 20, OTHER_RUN_ID, 103));

      const frames = events(await conn.waitFor((f) => events(f).length === 3));
      expect(frames.map((f) => f.id)).to.deep.equal(['101', '102', '103']);
      conn.close();
    });

    it('resumes after the global id in Last-Event-ID', async () => {
      fake.events.push(statusEvent(1, 'running', OTHER_RUN_ID, 101), progressEvent(2, 20, OTHER_RUN_ID, 102));

      const conn = await openSse(schedulePath, { ...reader, 'Last-Event-ID': '101' });
      const frames = events(await conn.waitFor((f) => events(f).length === 1));

      expect(frames[0].id).to.eq('102');
      conn.close();
    });

    it('answers 404 for an unknown schedule', async () => {
      const res = await req().get('scheduler/schedules/nope/events').set({ ...reader, Accept: 'text/event-stream, application/json;q=0.5' });
      expect(res).to.have.status(404);
    });
  });
});

describe('scheduler-http: SSE and server shutdown', function () {
  this.timeout(25000);

  before(async () => {
    const fake = await bootHttp();
    fake.runs.set(RUN_ID, makeRun());
  });

  after(async () => {
    await stopHttp();
  });

  it('closes open streams when the server stops instead of waiting for the shutdown watchdog', async () => {
    const conn = await openSse(runPath, reader);
    expect(conn.status).to.eq(200);

    const started = Date.now();
    const stopping = DI.get(HttpServer)!.stop();
    await conn.ended;
    await stopping;

    expect(Date.now() - started).to.be.lessThan(2000);
  });
});
