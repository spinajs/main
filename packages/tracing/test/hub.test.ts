import 'mocha';
import { expect } from 'chai';
import { ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { AlwaysOnSampler, InMemorySpanExporter, SamplingDecision, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
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
