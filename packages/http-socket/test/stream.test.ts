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

interface ICountedSource {
  iterator: AsyncIterator<unknown>;
  returnCalls: number;
}

/** Counts return() calls on top of a source, which ServerStream must make exactly once on every failure path. */
function counted(source: AsyncIterator<unknown>): ICountedSource {
  const counter: ICountedSource = {
    returnCalls: 0,
    iterator: {
      next: () => source.next(),
      return: (value?: unknown) => {
        counter.returnCalls++;
        return source.return ? source.return(value) : Promise.resolve({ done: true, value: undefined });
      },
    },
  };
  return counter;
}

/** A source whose next() settles only when the test says so. */
function manual() {
  const pending: Array<(result: IteratorResult<unknown>) => void> = [];
  let returnCalls = 0;
  const iterator: AsyncIterator<unknown> = {
    next: () => new Promise((resolve) => pending.push(resolve)),
    return: () => {
      returnCalls++;
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return {
    iterator,
    pending,
    get returnCalls() {
      return returnCalls;
    },
    push: (value: unknown) => pending.shift()?.({ done: false, value }),
  };
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
    backlogged: () => false,
    onDrain: () => () => undefined,
    ...patch,
  });

  const data = () => frames.filter((f) => f.event === WIRE_EVENTS.chunk).map((f) => f.frame.data);
  const last = () => frames[frames.length - 1];
  return { stream, frames, controller, data, last };
}

/** A transport whose write buffer the test fills and drains. */
function transport(backlogged = false) {
  const listeners = new Set<() => void>();
  const state = {
    backlogged,
    listeners,
    hooks: {
      backlogged: (): boolean => state.backlogged,
      onDrain: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies Partial<IServerStreamInit>,
    drain: () => {
      state.backlogged = false;
      [...listeners].forEach((listener) => listener());
    },
  };
  return state;
}

describe('ServerStream', () => {
  it('sends no more chunks than its credit, and asks the source for nothing beyond it', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, data, controller } = setup(counter(log));

    const outcome = stream.run();
    await tick();

    expect(data()).to.deep.equal([0, 1]);
    expect(log.produced).to.equal(2);
    expect(stream.sent).to.equal(2);

    controller.abort(new SocketException('cancelled', 'test over'));
    expect(await outcome).to.equal('cancelled');
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

  it('ignores a grant that is not an integer above 0', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, data, controller } = setup(counter(log), { credits: 2, maxCredits: 4 });

    const outcome = stream.run();
    await tick();
    for (const bad of [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      stream.grant(bad);
    }
    await tick();
    expect(data()).to.deep.equal([0, 1]);

    stream.grant(1);
    await tick();
    stream.grant(1);
    await tick();

    expect(data()).to.deep.equal([0, 1, 2, 3]);
    expect(controller.signal.aborted).to.be.false;
    controller.abort(new SocketException('cancelled', 'test over'));
    expect(await outcome).to.equal('cancelled');
  });

  it('a second run() returns the first outcome and pulls nothing more', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, frames } = setup(counter(log, 1));

    const first = stream.run();
    const second = stream.run();

    expect(await first).to.equal('ok');
    expect(await second).to.equal('ok');
    expect(log.produced).to.equal(1);
    expect(frames.map((f) => f.event)).to.deep.equal([WIRE_EVENTS.chunk, WIRE_EVENTS.end]);
  });

  it('still sends an internal fail frame and resolves when toWire throws', async () => {
    const { stream, frames } = setup(
      (async function* () {
        yield 'a';
        throw new Error('source broke');
      })(),
      {
        toWire: () => {
          throw new Error('the mapper broke too');
        },
      },
    );

    expect(await stream.run()).to.equal('internal');
    expect(frames[frames.length - 1].event).to.equal(WIRE_EVENTS.fail);
    expect((frames[frames.length - 1].frame.error as SocketError).code).to.equal('internal');
  });

  it('a second abort sends no second fail frame', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, frames, controller } = setup(counter(log), { credits: 1 });

    const outcome = stream.run();
    await tick();
    controller.abort(new SocketException('cancelled', 'cancelled by the client'));
    controller.abort(new SocketException('cancelled', 'cancelled again'));
    stream.grant(1);
    expect(await outcome).to.equal('cancelled');
    await tick();

    expect(frames.filter((f) => f.event === WIRE_EVENTS.fail)).to.have.length(1);
  });

  it('returns cancelled promptly when aborted while next() never settles', async () => {
    const source = manual();
    const { stream, frames, controller } = setup(source.iterator, { credits: 1 });

    const outcome = stream.run();
    await tick();
    expect(source.pending).to.have.length(1);

    controller.abort(new SocketException('cancelled', 'cancelled by the client'));

    expect(await Promise.race([outcome, tick(1000).then(() => 'still pending')])).to.equal('cancelled');
    expect(frames.map((f) => f.event)).to.deep.equal([WIRE_EVENTS.fail]);
    expect(source.returnCalls).to.equal(1);
  });

  it('settles only once a next() that ignored the abort settles', async () => {
    const source = manual();
    const { stream, controller } = setup(source.iterator, { credits: 1 });
    let settled = false;

    const outcome = stream.run();
    void stream.settled.then(() => (settled = true));
    await tick();
    controller.abort(new SocketException('cancelled', 'cancelled by the client'));

    expect(await outcome).to.equal('cancelled');
    await tick();
    expect(settled).to.be.false;

    source.push('late');
    await until(() => settled);
  });

  it('settles with run() when nothing of the source is pending', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream } = setup(counter(log, 1));

    expect(await stream.run()).to.equal('ok');
    await stream.settled;
  });

  it('a grant during a pending next() counts once that item is sent', async () => {
    const source = manual();
    const { stream, data, controller } = setup(source.iterator, { credits: 1, maxCredits: 4 });

    const outcome = stream.run();
    await tick();
    stream.grant(1);
    source.push('a');
    await tick();
    expect(source.pending).to.have.length(1);
    source.push('b');
    await tick();

    expect(data()).to.deep.equal(['a', 'b']);
    // no credit left: the stream waits instead of asking for a third item
    expect(source.pending).to.have.length(0);
    controller.abort(new SocketException('cancelled', 'test over'));
    expect(await outcome).to.equal('cancelled');
  });

  it('counts a grant during a pending next() against maxCredits', async () => {
    const source = manual();
    const { stream, last } = setup(source.iterator, { credits: 1, maxCredits: 4 });

    const outcome = stream.run();
    await tick();
    stream.grant(1);
    stream.grant(1);
    stream.grant(1);
    stream.grant(1);

    expect(await outcome).to.equal('invalid_argument');
    expect(last().frame.error).to.deep.include({ code: 'invalid_argument', details: { limit: 4 } });
  });

  it('a grant after an abort is a no-op', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, frames, controller } = setup(counter(log), { credits: 1, maxCredits: 4 });

    const outcome = stream.run();
    await tick();
    controller.abort(new SocketException('cancelled', 'cancelled by the client'));
    expect(await outcome).to.equal('cancelled');

    stream.grant(100);
    stream.grant(1);
    await tick();

    expect((controller.signal.reason as SocketException).code).to.equal('cancelled');
    expect(frames.map((f) => f.event)).to.deep.equal([WIRE_EVENTS.chunk, WIRE_EVENTS.fail]);
    expect(log.produced).to.equal(1);
  });

  describe('calls return() on the source exactly once', () => {
    it('when the source throws', async () => {
      const source = counted(
        (async function* () {
          yield 'a';
          throw new SocketException('not_found', 'gone');
        })(),
      );
      const { stream } = setup(source.iterator);

      expect(await stream.run()).to.equal('not_found');
      await tick();
      expect(source.returnCalls).to.equal(1);
    });

    it('when cancelled', async () => {
      const log: ISourceLog = { produced: 0, finallyRan: false };
      const source = counted(counter(log));
      const { stream, controller } = setup(source.iterator, { credits: 1 });

      const outcome = stream.run();
      await tick();
      controller.abort(new SocketException('cancelled', 'cancelled by the client'));

      expect(await outcome).to.equal('cancelled');
      await until(() => log.finallyRan);
      expect(source.returnCalls).to.equal(1);
    });

    it('when it stalls', async () => {
      const log: ISourceLog = { produced: 0, finallyRan: false };
      const source = counted(counter(log));
      const { stream } = setup(source.iterator, { credits: 1, stallTimeoutMs: 30 });

      expect(await stream.run()).to.equal('deadline_exceeded');
      await until(() => log.finallyRan);
      expect(source.returnCalls).to.equal(1);
    });

    it('when a chunk cannot be sent', async () => {
      const source = counted(
        (async function* () {
          yield 1n;
        })(),
      );
      const { stream } = setup(source.iterator, {
        send: (event) => {
          if (event === WIRE_EVENTS.chunk) {
            throw new TypeError('Do not know how to serialize a BigInt');
          }
        },
      });

      expect(await stream.run()).to.equal('internal');
      await tick();
      expect(source.returnCalls).to.equal(1);
    });

    it('never on a clean end', async () => {
      const log: ISourceLog = { produced: 0, finallyRan: false };
      const source = counted(counter(log, 1));
      const { stream } = setup(source.iterator);

      expect(await stream.run()).to.equal('ok');
      await tick();
      expect(source.returnCalls).to.equal(0);
    });
  });

  describe('transport backpressure', () => {
    it('pulls nothing while the transport is backlogged, though it holds credit, and resumes once it drains', async () => {
      const log: ISourceLog = { produced: 0, finallyRan: false };
      const wire = transport(true);
      const { stream, data, controller } = setup(counter(log), { credits: 3, ...wire.hooks });

      const outcome = stream.run();
      await tick();
      expect(log.produced).to.equal(0);
      expect(data()).to.deep.equal([]);

      wire.drain();
      await tick();
      expect(data()).to.deep.equal([0, 1, 2]);
      // now waiting for credit, through a single listener
      expect(wire.listeners.size).to.equal(1);

      controller.abort(new SocketException('cancelled', 'test over'));
      expect(await outcome).to.equal('cancelled');
      expect(wire.listeners.size).to.equal(0);
    });

    it('stops pulling as soon as the transport backs up mid-stream', async () => {
      const log: ISourceLog = { produced: 0, finallyRan: false };
      const wire = transport();
      const { stream, data, controller } = setup(counter(log), {
        credits: 4,
        ...wire.hooks,
        send: (event, frame) => {
          if (event === WIRE_EVENTS.chunk && (frame as { seq: number }).seq === 1) {
            wire.backlogged = true;
          }
        },
      });

      const outcome = stream.run();
      await tick();
      expect(log.produced).to.equal(2);

      wire.drain();
      await tick();
      expect(log.produced).to.equal(4);
      expect(data()).to.deep.equal([]);

      controller.abort(new SocketException('cancelled', 'test over'));
      expect(await outcome).to.equal('cancelled');
    });

    it('fails with deadline_exceeded and frees the source when the transport stays backlogged for stallTimeoutMs', async () => {
      const log: ISourceLog = { produced: 0, finallyRan: false };
      const wire = transport();
      const { stream, last, controller } = setup(counter(log), {
        credits: 4,
        stallTimeoutMs: 50,
        ...wire.hooks,
        send: () => {
          wire.backlogged = true;
        },
      });

      expect(await stream.run()).to.equal('deadline_exceeded');
      expect(log.produced).to.equal(1);
      expect(last()).to.equal(undefined);
      expect((controller.signal.reason as SocketException).code).to.equal('deadline_exceeded');
      await until(() => log.finallyRan);
      expect(wire.listeners.size).to.equal(0);
    });

    it('a drain that leaves the transport backlogged keeps the stream waiting', async () => {
      const log: ISourceLog = { produced: 0, finallyRan: false };
      const wire = transport(true);
      const { stream, controller } = setup(counter(log), { credits: 2, ...wire.hooks });

      const outcome = stream.run();
      await tick();
      [...wire.listeners].forEach((listener) => listener());
      await tick();
      expect(log.produced).to.equal(0);

      controller.abort(new SocketException('cancelled', 'test over'));
      expect(await outcome).to.equal('cancelled');
      expect(wire.listeners.size).to.equal(0);
    });
  });
});
