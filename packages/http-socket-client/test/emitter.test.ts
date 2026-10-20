import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Emitter, rethrowAsync } from '../src/emitter.js';

interface TestEvents {
  tick: (n: number) => void;
  pair: (a: string, b: number) => void;
}

describe('Emitter', () => {
  it('calls listeners in registration order with the emitted arguments', () => {
    const emitter = new Emitter<TestEvents>();
    const calls: string[] = [];
    emitter.on('pair', (a, b) => calls.push(`first ${a} ${b}`));
    emitter.on('pair', (a, b) => calls.push(`second ${a} ${b}`));

    emitter.emit('pair', 'x', 1);

    expect(calls).to.deep.equal(['first x 1', 'second x 1']);
  });

  it('on() returns an unsubscribe function', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: number[] = [];
    const unsubscribe = emitter.on('tick', (n) => seen.push(n));

    emitter.emit('tick', 1);
    unsubscribe();
    emitter.emit('tick', 2);

    expect(seen).to.deep.equal([1]);
    expect(emitter.listenerCount('tick')).to.equal(0);
  });

  it('off() removes a listener', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: number[] = [];
    const listener = (n: number): void => {
      seen.push(n);
    };
    emitter.on('tick', listener);

    emitter.off('tick', listener);
    emitter.emit('tick', 1);

    expect(seen).to.deep.equal([]);
  });

  it('once() fires a single time, and off() with the original listener removes it before it fires', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: number[] = [];
    emitter.once('tick', (n) => seen.push(n));
    emitter.emit('tick', 1);
    emitter.emit('tick', 2);
    expect(seen).to.deep.equal([1]);

    const listener = (n: number): void => {
      seen.push(n * 10);
    };
    emitter.once('tick', listener);
    emitter.off('tick', listener);
    emitter.emit('tick', 3);

    expect(seen).to.deep.equal([1]);
  });

  it('reports a throwing listener and still calls the others', () => {
    const errors: unknown[] = [];
    const emitter = new Emitter<TestEvents>((error) => errors.push(error));
    const seen: number[] = [];
    emitter.on('tick', () => {
      throw new Error('boom');
    });
    emitter.on('tick', (n) => seen.push(n));

    emitter.emit('tick', 7);

    expect(seen).to.deep.equal([7]);
    expect(errors).to.have.length(1);
    expect((errors[0] as Error).message).to.equal('boom');
  });

  it('rethrowAsync() surfaces the error on a later tick, not in the caller', () => {
    const clock = sinon.useFakeTimers();
    try {
      expect(() => rethrowAsync(new Error('later'))).to.not.throw();
      expect(() => clock.tick(1)).to.throw('later');
    } finally {
      clock.restore();
    }
  });

  it('listenerCount() counts per event and clear() drops everything', () => {
    const emitter = new Emitter<TestEvents>();
    emitter.on('tick', () => undefined);
    emitter.on('tick', () => undefined);
    emitter.on('pair', () => undefined);
    expect(emitter.listenerCount('tick')).to.equal(2);
    expect(emitter.listenerCount('pair')).to.equal(1);

    emitter.clear();

    expect(emitter.listenerCount('tick')).to.equal(0);
    expect(emitter.listenerCount('pair')).to.equal(0);
  });
});
