import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import type * as express from 'express';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { SSE_DEFAULT_HEARTBEAT_MS, SseResponse, SseStream, closeAllSseStreams } from '../src/response-methods/sse.js';

class FakeRes extends EventEmitter {
  public statusCode = 0;
  public headers: Record<string, string> = {};
  public chunks: string[] = [];
  public headersFlushed = false;
  public writableEnded = false;
  public destroyed = false;
  public flushes = 0;

  public status(code: number) {
    this.statusCode = code;
    return this;
  }
  public setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = String(value);
  }
  public flushHeaders() {
    this.headersFlushed = true;
  }
  public write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  public flush() {
    this.flushes++;
  }
  public end() {
    this.writableEnded = true;
    this.emit('close');
  }
  public get body() {
    return this.chunks.join('');
  }
}

const asRes = (r: FakeRes) => r as unknown as express.Response;
const noReq = {} as express.Request;

describe('SseStream', () => {
  let clock: sinon.SinonFakeTimers;
  let res: FakeRes;

  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    res = new FakeRes();
  });

  afterEach(() => {
    closeAllSseStreams();
    clock.restore();
  });

  it('writes event-stream headers that disable caching and compression', () => {
    new SseStream(asRes(res), 1000).open();

    expect(res.statusCode).to.eq(200);
    expect(res.headers['content-type']).to.eq('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).to.eq('no-cache, no-transform');
    expect(res.headers['connection']).to.eq('keep-alive');
    expect(res.headers['x-accel-buffering']).to.eq('no');
    expect(res.headersFlushed).to.eq(true);
  });

  it('frames an event with id, event name and JSON data, then flushes', () => {
    const stream = new SseStream(asRes(res), 0);
    stream.open();

    stream.send({ id: 3, event: 'progress', data: { progress: 50 } });

    expect(res.body).to.eq('id: 3\nevent: progress\ndata: {"progress":50}\n\n');
    expect(res.flushes).to.eq(1);
  });

  it('splits multi-line string data into several data lines', () => {
    const stream = new SseStream(asRes(res), 0);
    stream.open();

    stream.send({ data: 'first\nsecond' });

    expect(res.body).to.eq('data: first\ndata: second\n\n');
  });

  it('sends a ping comment on every heartbeat interval', () => {
    new SseStream(asRes(res), 15000).open();

    clock.tick(14999);
    expect(res.body).to.eq('');

    clock.tick(1);
    expect(res.body).to.eq(': ping\n\n');

    clock.tick(15000);
    expect(res.body).to.eq(': ping\n\n: ping\n\n');
  });

  it('defaults the heartbeat to 15 seconds', () => {
    expect(SSE_DEFAULT_HEARTBEAT_MS).to.eq(15000);
  });

  it('stops the heartbeat, ends the response and runs close callbacks exactly once', () => {
    const stream = new SseStream(asRes(res), 1000);
    const onClose = sinon.spy();
    stream.open();
    stream.onClose(onClose);

    stream.close();
    stream.close();
    clock.tick(10000);

    expect(stream.Closed).to.eq(true);
    expect(res.writableEnded).to.eq(true);
    expect(res.body).to.eq('');
    expect(onClose.calledOnce).to.eq(true);
  });

  it('treats a client disconnect as close and drops later sends', () => {
    const stream = new SseStream(asRes(res), 0);
    const onClose = sinon.spy();
    stream.open();
    stream.onClose(onClose);

    res.emit('close');
    stream.send({ data: 'late' });

    expect(onClose.calledOnce).to.eq(true);
    expect(res.body).to.eq('');
  });

  it('runs an onClose callback immediately when the stream is already closed', () => {
    const stream = new SseStream(asRes(res), 0);
    const onClose = sinon.spy();
    stream.open();
    stream.close();

    stream.onClose(onClose);

    expect(onClose.calledOnce).to.eq(true);
  });

  it('closes at once, without a heartbeat, when the client left before the stream opened', () => {
    res.destroyed = true;
    const stream = new SseStream(asRes(res), 1000);

    stream.open();

    expect(stream.Closed).to.eq(true);
    expect(clock.countTimers()).to.eq(0);
  });

  it('refuses an event name or id with a line break', () => {
    const stream = new SseStream(asRes(res), 0);
    stream.open();

    expect(() => stream.send({ event: 'a\ndata: injected', data: 1 })).to.throw(InvalidArgument);
    expect(() => stream.send({ event: 'a\rb', data: 1 })).to.throw(InvalidArgument);
    expect(() => stream.send({ id: '1\nevent: injected', data: 1 })).to.throw(InvalidArgument);
    expect(res.body).to.eq('');
  });

  it('closes every open stream when the http server starts closing', () => {
    const stream = new SseStream(asRes(res), 0);
    stream.open();

    DI.RootContainer.emit('http.server.closing');

    expect(stream.Closed).to.eq(true);
  });

  it('drops the kept-alive connection of a stream closed by the server shutdown', () => {
    const socket = { destroy: sinon.spy() };
    (res as unknown as { socket: typeof socket }).socket = socket;
    new SseStream(asRes(res), 0).open();

    DI.RootContainer.emit('http.server.closing');
    res.emit('finish');

    expect(socket.destroy.calledOnce).to.eq(true);
  });

  it('keeps the connection of a stream closed by the handler', () => {
    const socket = { destroy: sinon.spy() };
    (res as unknown as { socket: typeof socket }).socket = socket;
    const stream = new SseStream(asRes(res), 0);
    stream.open();

    stream.close();
    res.emit('finish');

    expect(socket.destroy.called).to.eq(false);
  });
});

describe('SseResponse', () => {
  afterEach(() => closeAllSseStreams());

  it('opens the stream and hands it to the handler, leaving it open', async () => {
    const res = new FakeRes();
    const seen: { stream?: SseStream } = {};

    await new SseResponse(
      (stream) => {
        seen.stream = stream;
        stream.send({ data: 'hi' });
      },
      { HeartbeatMs: 0 },
    ).execute(noReq, asRes(res));

    expect(seen.stream).to.be.instanceOf(SseStream);
    expect(seen.stream!.Closed).to.eq(false);
    expect(res.body).to.eq('data: hi\n\n');
  });

  it('reports a handler failure as a stream-error event and closes', async () => {
    const res = new FakeRes();

    await new SseResponse(
      () => {
        throw new Error('boom');
      },
      { HeartbeatMs: 0 },
    ).execute(noReq, asRes(res));

    expect(res.body).to.eq('event: stream-error\ndata: {"message":"boom"}\n\n');
    expect(res.writableEnded).to.eq(true);
  });

  it('applies custom response headers', async () => {
    const res = new FakeRes();

    await new SseResponse(() => undefined, { HeartbeatMs: 0, Headers: [{ Name: 'X-Run-Id', Value: 'r1' }] }).execute(noReq, asRes(res));

    expect(res.headers['x-run-id']).to.eq('r1');
  });
});
