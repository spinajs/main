import 'mocha';
import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import type * as express from 'express';
import { ISseEvent, SseStream } from '@spinajs/http';
import { formatSseEvent } from '@spinajs/scheduler';

import { IEventSink, streamRunEvents, streamScheduleEvents } from '../src/sse/run-events.js';
import { FakeSchedulerService, OTHER_RUN_ID, progressEvent, RUN_ID, SCHEDULE_NAME, statusEvent, stepStartEvent } from './fakes/fake-scheduler.js';

class RecordingSink implements IEventSink {
  public sent: ISseEvent[] = [];
  public Closed = false;
  private callbacks: Array<() => void> = [];

  public send(event: ISseEvent): void {
    if (!this.Closed) {
      this.sent.push(event);
    }
  }

  public close(): void {
    if (this.Closed) {
      return;
    }
    this.Closed = true;
    this.callbacks.splice(0).forEach((cb) => cb());
  }

  public onClose(callback: () => void): void {
    if (this.Closed) {
      callback();
    } else {
      this.callbacks.push(callback);
    }
  }

  public get ids() {
    return this.sent.map((e) => e.id);
  }
}

class WireRes extends EventEmitter {
  public chunks: string[] = [];
  public writableEnded = false;
  public status() {
    return this;
  }
  public setHeader() {}
  public flushHeaders() {}
  public write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  public end() {
    this.writableEnded = true;
    this.emit('close');
  }
}

describe('streamRunEvents', () => {
  let fake: FakeSchedulerService;
  let sink: RecordingSink;
  const running = { id: RUN_ID, status: 'running' as const };

  beforeEach(() => {
    fake = new FakeSchedulerService();
    sink = new RecordingSink();
    fake.events = [statusEvent(1, 'running'), stepStartEvent(2, 'load'), progressEvent(3, 50)];
  });

  it('sends each event with its seq as id, its type as event name and the event as data', async () => {
    await streamRunEvents(sink, fake, running, 1);

    expect(sink.sent[0]).to.deep.equal({ id: '2', event: 'step-start', data: stepStartEvent(2, 'load') });
  });

  it('writes exactly the frames formatSseEvent produces', async () => {
    const res = new WireRes();
    const stream = new SseStream(res as unknown as express.Response, 0);
    stream.open();

    await streamRunEvents(stream, fake, running, 0);

    const target = { runId: RUN_ID };
    expect(res.chunks.join('')).to.eq(fake.events.map((e) => formatSseEvent(target, e)).join(''));
    stream.close();
  });

  it('subscribes with after and streams live events after the replay', async () => {
    await streamRunEvents(sink, fake, running, 1);
    expect(fake.callsTo('subscribe')[0]).to.deep.equal([{ runId: RUN_ID }, { after: 1 }]);
    expect(sink.ids).to.deep.equal(['2', '3']);

    fake.emit(progressEvent(4, 75));

    expect(sink.ids).to.deep.equal(['2', '3', '4']);
    expect(sink.Closed).to.eq(false);
  });

  it('drops an event delivered twice', async () => {
    await streamRunEvents(sink, fake, running, 3);

    fake.deliverTwice(progressEvent(4, 75));

    expect(sink.ids).to.deep.equal(['4']);
  });

  it('sends a synthetic progress event at the last position without moving it', async () => {
    await streamRunEvents(sink, fake, running, 3);

    fake.emit({ ...progressEvent(3, 80), synthetic: true });
    fake.emit(progressEvent(4, 90));

    expect(sink.ids).to.deep.equal(['3', '4']);
    expect(sink.sent[0].data).to.deep.include({ synthetic: true, progress: 80 });
  });

  it('closes after the terminal status and unsubscribes', async () => {
    await streamRunEvents(sink, fake, running, 0);

    fake.emit(statusEvent(4, 'succeeded'));
    fake.emit(progressEvent(5, 100));

    expect(sink.Closed).to.eq(true);
    expect(sink.ids).to.deep.equal(['1', '2', '3', '4']);
    expect(fake.activeSubscriptions).to.eq(0);
  });

  it('stays open through an automatic retry and closes on the final status', async () => {
    await streamRunEvents(sink, fake, running, 3);

    fake.emit(statusEvent(4, 'retrying'));
    expect(sink.Closed).to.eq(false);

    fake.emit({ ...statusEvent(5, 'running'), attempt: 2 });
    fake.emit({ ...progressEvent(6, 50), attempt: 2 });
    expect(sink.Closed).to.eq(false);

    fake.emit({ ...statusEvent(7, 'dead'), attempt: 2 });
    expect(sink.ids).to.deep.equal(['4', '5', '6', '7']);
    expect(sink.Closed).to.eq(true);
  });

  it('stays open while an emitted run waits for its queue job', async () => {
    await streamRunEvents(sink, fake, { id: RUN_ID, status: 'emitted' }, 3);

    fake.emit(statusEvent(4, 'emitted'));

    expect(sink.Closed).to.eq(false);
  });

  it('closes when an emitted run ends without its queue job ( emit-timeout or cancel )', async () => {
    for (const [status, reason] of [
      ['failed', 'emit-timeout'],
      ['aborted', 'cancelled'],
    ] as const) {
      const local = new FakeSchedulerService();
      const out = new RecordingSink();
      await streamRunEvents(out, local, { id: RUN_ID, status: 'emitted' }, 0);

      local.emit(statusEvent(1, 'emitted'));
      local.emit({ ...statusEvent(2, status), reason });

      expect(out.ids, status).to.deep.equal(['1', '2']);
      expect(out.Closed, status).to.eq(true);
    }
  });

  it('closes right after the replay when it contains the terminal status', async () => {
    fake.events.push(statusEvent(4, 'dead'));

    await streamRunEvents(sink, fake, { id: RUN_ID, status: 'dead' }, 2);

    expect(sink.ids).to.deep.equal(['3', '4']);
    expect(sink.Closed).to.eq(true);
    expect(fake.activeSubscriptions).to.eq(0);
  });

  it('closes a run that had already ended when nothing is left to replay', async () => {
    await streamRunEvents(sink, fake, { id: RUN_ID, status: 'succeeded' }, 3);

    expect(sink.sent).to.be.empty;
    expect(sink.Closed).to.eq(true);
    expect(fake.activeSubscriptions).to.eq(0);
  });

  it('unsubscribes when the client disconnects', async () => {
    await streamRunEvents(sink, fake, running, 0);
    expect(fake.activeSubscriptions).to.eq(1);

    sink.close();

    expect(fake.activeSubscriptions).to.eq(0);
    expect(fake.unsubscriptions).to.eq(1);
  });
});

describe('streamScheduleEvents', () => {
  let fake: FakeSchedulerService;
  let sink: RecordingSink;

  beforeEach(() => {
    fake = new FakeSchedulerService();
    sink = new RecordingSink();
  });

  it('is live only without after, and uses the global id across runs', async () => {
    fake.events = [statusEvent(1, 'running', RUN_ID, 100)];

    await streamScheduleEvents(sink, fake, SCHEDULE_NAME, undefined);
    fake.emit(statusEvent(1, 'running', OTHER_RUN_ID, 101));
    fake.emit(progressEvent(2, 10, RUN_ID, 102));
    fake.emit({ ...progressEvent(3, 20, RUN_ID, 103), schedule: 'other-schedule' });

    expect(fake.callsTo('subscribe')[0]).to.deep.equal([{ schedule: SCHEDULE_NAME }, {}]);
    expect(sink.ids).to.deep.equal(['101', '102']);
  });

  it('replays events of every run after the given global id', async () => {
    fake.events = [statusEvent(1, 'running', RUN_ID, 100), statusEvent(1, 'running', OTHER_RUN_ID, 101), progressEvent(2, 50, RUN_ID, 102)];

    await streamScheduleEvents(sink, fake, SCHEDULE_NAME, 100);

    expect(sink.ids).to.deep.equal(['101', '102']);
  });

  it('sends a synthetic progress event at the current global id', async () => {
    await streamScheduleEvents(sink, fake, SCHEDULE_NAME, 102);

    fake.emit({ ...progressEvent(2, 60, RUN_ID, 102), synthetic: true });
    fake.emit(progressEvent(3, 70, RUN_ID, 103));

    expect(sink.ids).to.deep.equal(['102', '103']);
  });

  it('does not close when a run ends', async () => {
    await streamScheduleEvents(sink, fake, SCHEDULE_NAME, undefined);

    fake.emit(statusEvent(1, 'succeeded', RUN_ID, 100));

    expect(sink.Closed).to.eq(false);
  });

  it('unsubscribes when the client disconnects', async () => {
    await streamScheduleEvents(sink, fake, SCHEDULE_NAME, undefined);

    sink.close();

    expect(fake.activeSubscriptions).to.eq(0);
  });
});
