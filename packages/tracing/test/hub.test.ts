import 'mocha';
import { expect } from 'chai';
import { ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { AlwaysOnSampler, BasicTracerProvider, InMemorySpanExporter, SamplingDecision, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { HubSampler, SpanProcessorHub } from '../src/hub.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

const collecting = (into: ReadableSpan[]): SpanProcessor => ({
  onStart: () => undefined,
  onEnd: (span) => {
    into.push(span);
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
});

const throwing: SpanProcessor = {
  onStart: () => {
    throw new Error('onStart');
  },
  onEnd: () => {
    throw new Error('onEnd');
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

describe('SpanProcessorHub', () => {
  it('counts attached processors and detaches once', async () => {
    const hub = new SpanProcessorHub();
    const detach = hub.add(new SimpleSpanProcessor(new InMemorySpanExporter()));
    expect(hub.size).to.eq(1);
    await detach();
    await detach();
    expect(hub.size).to.eq(0);
  });

  it('forwards onEnd to every processor even when one throws', () => {
    const hub = new SpanProcessorHub();
    const ended: ReadableSpan[] = [];
    hub.add(throwing);
    hub.add(collecting(ended));
    const span = { name: 'survives' } as unknown as ReadableSpan;
    hub.onEnd(span);
    expect(ended).to.deep.eq([span]);
  });

  it('flushes and shuts a processor down on detach', async () => {
    const calls: string[] = [];
    const hub = new SpanProcessorHub();
    const detach = hub.add({
      onStart: () => undefined,
      onEnd: () => undefined,
      forceFlush: () => {
        calls.push('flush');
        return Promise.resolve();
      },
      shutdown: () => {
        calls.push('shutdown');
        return Promise.resolve();
      },
    });
    await detach();
    expect(calls).to.deep.eq(['flush', 'shutdown']);
  });

  it('still shuts a processor down on detach when its flush rejects, and rejects with that error', async () => {
    const calls: string[] = [];
    const hub = new SpanProcessorHub();
    const detach = hub.add({
      onStart: () => undefined,
      onEnd: () => undefined,
      forceFlush: () => Promise.reject(new Error('flush')),
      shutdown: () => {
        calls.push('shutdown');
        return Promise.resolve();
      },
    });
    let thrown: unknown;
    try {
      await detach();
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).to.eq('flush');
    expect(calls).to.deep.eq(['shutdown']);
  });

  it('rejects with the first error only after every processor has shut down', async () => {
    const calls: string[] = [];
    const hub = new SpanProcessorHub();
    hub.add({ ...collecting([]), shutdown: () => Promise.reject(new Error('first')) });
    hub.add({
      ...collecting([]),
      shutdown: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            calls.push('second');
            resolve();
          }, 10),
        ),
    });
    let thrown: unknown;
    try {
      await hub.shutdown();
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).to.eq('first');
    expect(calls).to.deep.eq(['second']);
  });

  it('forwards onEnding before onEnd, while the span still takes attributes', () => {
    const order: string[] = [];
    let seen: unknown;
    const hub = new SpanProcessorHub();
    hub.add({
      ...collecting([]),
      onEnding: (span) => {
        order.push('onEnding');
        span.setAttribute('late', 'yes');
      },
      onEnd: (span) => {
        order.push('onEnd');
        seen = span.attributes.late;
      },
    });
    new BasicTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [hub] }).getTracer('hub-test').startSpan('ending').end();
    expect(order).to.deep.eq(['onEnding', 'onEnd']);
    expect(seen).to.eq('yes');
  });
});

describe('HubSampler', () => {
  const decide = (sampler: HubSampler): SamplingDecision => sampler.shouldSample(ROOT_CONTEXT, TRACE_ID, 'x', SpanKind.INTERNAL, {}, []).decision;

  it('answers NOT_RECORD while the hub is empty and the delegate otherwise', async () => {
    const hub = new SpanProcessorHub();
    const sampler = new HubSampler(hub, new AlwaysOnSampler());
    expect(decide(sampler)).to.eq(SamplingDecision.NOT_RECORD);

    const detach = hub.add(new SimpleSpanProcessor(new InMemorySpanExporter()));
    expect(decide(sampler)).to.eq(SamplingDecision.RECORD_AND_SAMPLED);
    await detach();
    expect(decide(sampler)).to.eq(SamplingDecision.NOT_RECORD);
  });
});
