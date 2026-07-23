import 'mocha';
import { expect } from 'chai';

import { InMemoryPerfSink } from './../src/InMemoryPerfSink.js';

function makeSink(enabled = true, maxNames = 200) {
  const sink = new InMemoryPerfSink();
  // @Config installs getter-only accessors on the prototype ( no setter,
  // configurable: false ), so plain assignment throws in strict-mode ESM.
  // Shadow them with own data properties on the instance instead.
  Object.defineProperty(sink, 'Enabled', { value: enabled, configurable: true, writable: true });
  Object.defineProperty(sink, 'MaxNames', { value: maxNames, configurable: true, writable: true });
  return sink;
}

describe('InMemoryPerfSink', () => {
  it('aggregates span count, total and max', () => {
    const sink = makeSink();

    sink.collect({ name: 'orm.query', kind: 'span', durationMs: 10 });
    sink.collect({ name: 'orm.query', kind: 'span', durationMs: 30 });

    const spans = sink.toJSON().spans;
    expect(spans).to.have.length(1);
    expect(spans[0].name).to.eq('orm.query');
    expect(spans[0].count).to.eq(2);
    expect(spans[0].totalMs).to.eq(40);
    expect(spans[0].avgMs).to.eq(20);
    expect(spans[0].maxMs).to.eq(30);
  });

  it('aggregates counter and value events separately from spans', () => {
    const sink = makeSink();

    sink.collect({ name: 'cache.miss', kind: 'counter', value: 2 });
    sink.collect({ name: 'cache.miss', kind: 'counter', value: 3 });
    sink.collect({ name: 'queue.depth', kind: 'value', value: 7 });

    const json = sink.toJSON();
    expect(json.spans).to.have.length(0);
    expect(json.events).to.have.length(2);

    const miss = json.events.find((e) => e.name === 'cache.miss')!;
    expect(miss.count).to.eq(2);
    expect(miss.total).to.eq(5);
  });

  it('defaults a missing duration to 0 and a missing value to 1', () => {
    const sink = makeSink();

    sink.collect({ name: 'a', kind: 'span' });
    sink.collect({ name: 'b', kind: 'counter' });

    expect(sink.toJSON().spans[0].totalMs).to.eq(0);
    expect(sink.toJSON().events[0].total).to.eq(1);
  });

  it('sorts spans by total time and events by total, descending', () => {
    const sink = makeSink();

    sink.collect({ name: 'small', kind: 'span', durationMs: 1 });
    sink.collect({ name: 'big', kind: 'span', durationMs: 100 });
    sink.collect({ name: 'few', kind: 'counter', value: 1 });
    sink.collect({ name: 'many', kind: 'counter', value: 50 });

    const json = sink.toJSON();
    expect(json.spans[0].name).to.eq('big');
    expect(json.events[0].name).to.eq('many');
  });

  it('stops adding new names past maxNames and reports truncation', () => {
    const sink = makeSink(true, 2);

    sink.collect({ name: 'a', kind: 'span', durationMs: 1 });
    sink.collect({ name: 'b', kind: 'span', durationMs: 1 });
    sink.collect({ name: 'c', kind: 'span', durationMs: 1 });

    const json = sink.toJSON();
    expect(json.spans).to.have.length(2);
    expect(json.truncated).to.eq(true);
  });

  it('counts spans and events against the same name budget', () => {
    const sink = makeSink(true, 1);

    sink.collect({ name: 'a', kind: 'span', durationMs: 1 });
    sink.collect({ name: 'b', kind: 'counter', value: 1 });

    const json = sink.toJSON();
    expect(json.spans).to.have.length(1);
    expect(json.events).to.have.length(0);
    expect(json.truncated).to.eq(true);
  });

  it('collects nothing when disabled', () => {
    const sink = makeSink(false);

    sink.collect({ name: 'a', kind: 'span', durationMs: 1 });

    expect(sink.toJSON().spans).to.have.length(0);
  });

  it('never throws on a malformed metric', () => {
    const sink = makeSink();
    sink.collect({} as any);
    sink.collect(null as any);
  });
});
