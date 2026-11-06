import 'mocha';
import { expect } from 'chai';

import { DEFAULT_TRACING_OPTIONS, ensureTracing, tracer } from '../src/index.js';
import { resetTracing } from '../src/testing.js';

const N = 100_000;
const BUDGET_NS = 1_000;

describe('id-only cost (SPINAJS_BENCH=1)', function () {
  this.timeout(60000);

  before(async function () {
    if (!process.env.SPINAJS_BENCH) this.skip();
    await resetTracing();
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'bench' });
  });

  after(() => resetTracing());

  it(`stays under ${BUDGET_NS} ns per startSpan/end with an empty hub`, () => {
    const run = (): number => {
      const start = process.hrtime.bigint();
      for (let i = 0; i < N; i++) tracer().startSpan('bench').end();
      return Number(process.hrtime.bigint() - start) / N;
    };
    for (let i = 0; i < 5; i++) run();
    const perSpan = run();
    console.log(`id-only: ${perSpan.toFixed(0)} ns per span`);
    expect(perSpan).to.be.below(BUDGET_NS);
  });
});
