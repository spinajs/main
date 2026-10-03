import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import type { SocketError } from '@spinajs/http-socket-common';
import { IServerStreamInit, ServerStream } from '../src/stream.js';

interface IFrame {
  event: string;
  frame: Record<string, unknown>;
}

interface ISourceLog {
  produced: number;
  finallyRan: boolean;
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await tick(5);
  }
}

function toWire(err: unknown): SocketError {
  return err instanceof SocketException ? err.toWire() : { code: 'internal', message: err instanceof Error ? err.message : String(err), retryable: false };
}

function counter(log: ISourceLog, n = Number.POSITIVE_INFINITY): AsyncGenerator<number> {
  return (async function* () {
    try {
      for (let i = 0; i < n; i++) {
        log.produced++;
        yield i;
      }
    } finally {
      log.finallyRan = true;
    }
  })();
}

function setup(iterator: AsyncIterator<unknown>, patch: Partial<IServerStreamInit> = {}) {
  const controller = new AbortController();
  const frames: IFrame[] = [];
  const stream = new ServerStream({
    id: 's-1',
    name: 'strm.unit',
    iterator,
    signal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
    credits: 2,
    maxCredits: 8,
    stallTimeoutMs: 5_000,
    send: (event, frame) => {
      frames.push({ event, frame: frame as unknown as Record<string, unknown> });
    },
    within: (step) => step(),
    toWire,
    ...patch,
  });

  const data = () => frames.filter((f) => f.event === WIRE_EVENTS.chunk).map((f) => f.frame.data);
  const last = () => frames[frames.length - 1];
  return { stream, frames, controller, data, last };
}

describe('ServerStream', () => {
  it('sends no more chunks than its credit, and asks the source for nothing beyond it', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, data } = setup(counter(log));

    void stream.run();
    await tick();

    expect(data()).to.deep.equal([0, 1]);
    expect(log.produced).to.equal(2);
    expect(stream.sent).to.equal(2);
  });

  it('continues as credit arrives and ends with the number of chunks sent', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, data, last } = setup(counter(log, 3));

    const outcome = stream.run();
    await tick();
    // one for the last chunk, one to find the end
    stream.grant(2);

    expect(await outcome).to.equal('ok');
    expect(data()).to.deep.equal([0, 1, 2]);
    expect(last()).to.deep.equal({ event: WIRE_EVENTS.end, frame: { id: 's-1', seq: 3 } });
  });

  it('numbers chunks from 0 and sends an undefined item as null', async () => {
    const { stream, frames } = setup(
      (async function* () {
        yield undefined;
      })(),
    );

    expect(await stream.run()).to.equal('ok');
    expect(frames[0]).to.deep.equal({ event: WIRE_EVENTS.chunk, frame: { id: 's-1', seq: 0, data: null } });
  });

  it('sends the mapped error after the chunks already sent when the source throws, and fires the signal', async () => {
    const { stream, data, last, controller } = setup(
      (async function* () {
        yield 'a';
        throw new SocketException('not_found', 'the rest is gone');
      })(),
    );

    expect(await stream.run()).to.equal('not_found');
    expect(data()).to.deep.equal(['a']);
    expect(last()).to.deep.equal({ event: WIRE_EVENTS.fail, frame: { id: 's-1', error: { code: 'not_found', message: 'the rest is gone', retryable: false } } });
    expect(controller.signal.aborted).to.be.true;
  });

  it('fails with the abort reason and runs the source finally block when aborted while waiting for credit', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, last, controller } = setup(counter(log), { credits: 1 });

    const outcome = stream.run();
    await tick();
    controller.abort(new SocketException('cancelled', 'cancelled by the client'));

    expect(await outcome).to.equal('cancelled');
    expect((last().frame.error as SocketError).code).to.equal('cancelled');
    await until(() => log.finallyRan);
  });

  it('fails a stream that gets no credit within stallTimeoutMs with deadline_exceeded', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, last, controller } = setup(counter(log), { credits: 1, stallTimeoutMs: 50 });

    expect(await stream.run()).to.equal('deadline_exceeded');
    expect(last().frame.error).to.deep.include({ code: 'deadline_exceeded', retryable: true });
    expect((controller.signal.reason as SocketException).code).to.equal('deadline_exceeded');
    await until(() => log.finallyRan);
  });

  it('fails the stream with invalid_argument when a grant would leave more than maxCredits outstanding', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, last } = setup(counter(log), { credits: 2, maxCredits: 4 });

    const outcome = stream.run();
    await tick();
    stream.grant(5);

    expect(await outcome).to.equal('invalid_argument');
    expect(last().frame.error).to.deep.include({ code: 'invalid_argument', details: { limit: 4 } });
  });

  it('accepts grants up to maxCredits outstanding', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, data } = setup(counter(log), { credits: 2, maxCredits: 4 });

    void stream.run();
    await tick();
    stream.grant(4);
    await tick();

    expect(data()).to.deep.equal([0, 1, 2, 3, 4, 5]);
  });

  it('fails with internal when a chunk cannot be sent', async () => {
    const frames: IFrame[] = [];
    const { stream } = setup(
      (async function* () {
        yield 1n;
      })(),
      {
        send: (event, frame) => {
          if (event === WIRE_EVENTS.chunk) {
            throw new TypeError('Do not know how to serialize a BigInt');
          }
          frames.push({ event, frame: frame as unknown as Record<string, unknown> });
        },
      },
    );

    expect(await stream.run()).to.equal('internal');
    expect(frames.map((f) => f.event)).to.deep.equal([WIRE_EVENTS.fail]);
  });

  it('runs every step of the source through within()', async () => {
    const als = new AsyncLocalStorage<{ tag: string }>();
    const { stream, data } = setup(
      (async function* () {
        for (let i = 0; i < 2; i++) {
          await tick(5);
          yield als.getStore()?.tag ?? null;
        }
      })(),
      { credits: 4, within: (step) => als.run({ tag: 'call-store' }, step) },
    );

    expect(await stream.run()).to.equal('ok');
    expect(data()).to.deep.equal(['call-store', 'call-store']);
  });

  it('fails at once, without starting the source, when its signal fired before run()', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, frames, controller } = setup(counter(log));
    controller.abort(new SocketException('unavailable', 'connection closed'));

    expect(await stream.run()).to.equal('unavailable');
    expect(log.produced).to.equal(0);
    expect(frames.map((f) => f.event)).to.deep.equal([WIRE_EVENTS.fail]);
  });
});
