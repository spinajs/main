import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';

// Deliberately imported from THIS package, not from `@spinajs/telemetry`: the point of the
// extraction is that the metric abstraction stands on its own, with `@spinajs/di` and prom-client
// as its only dependencies. A test that reached through `@spinajs/telemetry` would prove nothing
// about that, because it would drag in http / log / validation / configuration.
import { Metrics } from '../src/index.js';

describe('Metrics ( telemetry-common )', () => {
  afterEach(() => DI.clearCache());

  it('is a DI singleton, so every consumer writes into one registry', () => {
    expect(DI.resolve(Metrics)).to.equal(DI.resolve(Metrics));
  });

  it('defineMetrics prefixes names and registers against the private registry', async () => {
    const m = DI.resolve(Metrics);
    const map = m.defineMetrics('unit', [
      { name: 'things_total', help: 'things', type: 'counter', labelNames: ['kind'] },
      { name: 'size', help: 'size', type: 'gauge', labelNames: ['kind'] },
      { name: 'seconds', help: 'seconds', type: 'histogram', labelNames: ['kind'], buckets: [0.1, 1] },
    ]);

    (map['things_total'] as any).inc({ kind: 'a' }, 2);
    (map['size'] as any).set({ kind: 'a' }, 7);
    (map['seconds'] as any).observe({ kind: 'a' }, 0.5);

    const out = await m.render();

    expect(out).to.contain('unit_things_total{kind="a"} 2');
    expect(out).to.contain('unit_size{kind="a"} 7');
    expect(out).to.contain('unit_seconds_count{kind="a"} 1');
  });

  it('never touches prom-client\'s global default registry', async () => {
    const a = DI.resolve(Metrics);
    a.defineMetrics('iso', [{ name: 'only_here', help: 'h', type: 'counter' }]);

    DI.clearCache();

    // A second service owns a second registry — repeated init in tests, or two SpinaJS apps in
    // one process, must not collide on an already-registered metric name.
    const b = DI.resolve(Metrics);
    expect(b).to.not.equal(a);
    expect(await b.render()).to.not.contain('iso_only_here');
    expect(() => b.defineMetrics('iso', [{ name: 'only_here', help: 'h', type: 'counter' }])).to.not.throw();
  });

  it('rebuilds rather than throwing when a metric name is defined twice', () => {
    const m = DI.resolve(Metrics);
    m.defineMetrics('dup', [{ name: 'x', help: 'h', type: 'gauge' }]);

    expect(() => m.defineMetrics('dup', [{ name: 'x', help: 'h', type: 'gauge' }])).to.not.throw();
  });
});
