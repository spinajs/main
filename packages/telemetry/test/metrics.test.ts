import 'mocha';
import { expect } from 'chai';

import { Metrics } from './../src/index.js';
import { Counter, Gauge, Histogram } from 'prom-client';

describe('Metrics — declarative registry', () => {
  it('defineMetrics builds counter / gauge / histogram registered to the private registry', () => {
    const m = new Metrics();
    const map = m.defineMetrics('test', [
      { name: 'hits', help: 'hits', type: 'counter', labelNames: ['route'] },
      { name: 'live', help: 'live', type: 'gauge' },
      { name: 'dur', help: 'dur', type: 'histogram', buckets: [1, 5, 10] },
    ]);

    expect(map['hits']).to.be.instanceOf(Counter);
    expect(map['live']).to.be.instanceOf(Gauge);
    expect(map['dur']).to.be.instanceOf(Histogram);

    // registered under the prefixed names on THIS registry
    expect(m.getRegistry().getSingleMetric('test_hits')).to.not.be.undefined;
    expect(m.getRegistry().getSingleMetric('test_live')).to.not.be.undefined;
    expect(m.getRegistry().getSingleMetric('test_dur')).to.not.be.undefined;
  });

  it('incrementing a counter + observing a histogram shows up in the awaited render()', async () => {
    const m = new Metrics();
    const map = m.defineMetrics('test', [
      { name: 'hits', help: 'hits', type: 'counter', labelNames: ['route'] },
      { name: 'dur', help: 'dur', type: 'histogram', buckets: [1, 5, 10] },
    ]);

    (map['hits'] as Counter<string>).inc({ route: '/x' }, 3);
    (map['dur'] as Histogram<string>).observe({}, 4);

    const text = await m.render();

    expect(text).to.contain('test_hits');
    expect(text).to.contain('test_dur');
    // the counter sample value shows up
    expect(text).to.match(/test_hits\{route="\/x"\}\s+3/);
    // histogram emits a _count series
    expect(text).to.contain('test_dur_count');
  });

  it('duplicate defineMetrics call does not throw ( remove + recreate )', () => {
    const m = new Metrics();
    const defs = [{ name: 'hits', help: 'hits', type: 'counter' as const }];
    m.defineMetrics('test', defs);
    expect(() => m.defineMetrics('test', defs)).to.not.throw();
    // still exactly one registered
    expect(m.getRegistry().getSingleMetric('test_hits')).to.not.be.undefined;
  });

  it('contentType() is the prometheus exposition content type', () => {
    const m = new Metrics();
    expect(m.contentType()).to.contain('text/plain');
  });

  it('collectDefault() adds process_* / nodejs_* series', async () => {
    const m = new Metrics();
    m.collectDefault();
    const text = await m.render();
    expect(text).to.contain('process_cpu_user_seconds_total');
    expect(text).to.match(/nodejs_/);
  });

  it('each Metrics instance owns an isolated registry ( not the global default )', async () => {
    const a = new Metrics();
    const b = new Metrics();
    a.defineMetrics('a', [{ name: 'x', help: 'x', type: 'counter' }]);

    const textB = await b.render();
    expect(textB).to.not.contain('a_x');
  });
});

describe('Metrics — summary support', () => {
  it('constructs a Summary for type "summary" and registers it', async () => {
    const m = new Metrics();
    const map = m.defineMetrics('jobs', [{ name: 'latency_ms', help: 'Job latency', type: 'summary', labelNames: ['queue'], percentiles: [0.5, 0.9, 0.99] }]);

    expect(map['latency_ms']).to.not.be.undefined;
    expect(m.getRegistry().getSingleMetric('jobs_latency_ms')).to.not.be.undefined;

    (map['latency_ms'] as any).observe({ queue: 'default' }, 12);

    const text = await m.render();
    expect(text).to.contain('jobs_latency_ms');
    expect(text).to.contain('quantile="0.9"');
  });
});
