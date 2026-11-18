import 'mocha';
import { expect } from 'chai';
import { cpus, loadavg } from 'node:os';
import { ProxyTracerProvider } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { DEFAULT_TRACING_OPTIONS, ensureTracing, tracer, tracingState } from '../src/index.js';
import { resetTracing } from '../src/testing.js';

const N = 100_000;
const RUNS = 7;
const BUDGET_NS = 1_000;

function perSpanNs(start: () => { end(): void }): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) start().end();
  return Number(process.hrtime.bigint() - t0) / N;
}

function median(run: () => number): number {
  for (let i = 0; i < 3; i++) run();
  const samples = Array.from({ length: RUNS }, run).sort((a, b) => a - b);
  return samples[Math.floor(RUNS / 2)];
}

class DropProcessor implements SpanProcessor {
  public onStart(): void {}
  public onEnd(): void {}
  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe('span cost (SPINAJS_BENCH=1)', function () {
  this.timeout(180000);
  const results: Record<string, number> = {};

  before(async function () {
    if (!process.env.SPINAJS_BENCH) this.skip();
    await resetTracing();
  });

  after(async () => {
    // mocha runs this hook also when `before` skipped the suite
    if (!process.env.SPINAJS_BENCH) return;
    console.log(JSON.stringify({ cpu: cpus()[0]?.model, node: process.version, loadavg: loadavg(), ...results }));
    await resetTracing();
  });

  it('API no-op tracer (reference)', () => {
    const noop = new ProxyTracerProvider().getTracer('bench');
    results.noopNs = median(() => perSpanNs(() => noop.startSpan('bench')));
  });

  it(`id-only stays under ${BUDGET_NS} ns per startSpan/end (median of ${RUNS})`, () => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'bench' });
    results.idOnlyNs = median(() => perSpanNs(() => tracer().startSpan('bench')));
    expect(results.idOnlyNs).to.be.below(BUDGET_NS);
  });

  it('recording with one processor that drops every span (reported, no budget)', async () => {
    const hub = tracingState().hub;
    if (!hub) throw new Error('tracing is not owned by spinajs');
    const detach = hub.add(new DropProcessor());
    try {
      results.recordingNs = median(() => perSpanNs(() => tracer().startSpan('bench')));
    } finally {
      await detach();
    }
  });
});
