import 'mocha';
import { expect } from 'chai';

import { TelemetryStore } from './../src/index.js';

/**
 * The store is deliberately usable without DI — the field initializers build
 * the aggregates with defaults and `resolve()` only rebuilds them from
 * configuration — so these stay pure unit tests.
 */
describe('TelemetryStore', () => {
  it('is usable straight from `new` ( no DI boot )', () => {
    const store = new TelemetryStore();

    expect(store.RequestStats.toJSON().requests).to.eq(0);
    expect(store.Timeline.toJSON()).to.deep.eq({});
    expect(store.RouteStats.toJSON().routes).to.have.length(0);
  });

  it('stamps StartedAt so request rates can be computed', () => {
    const store = new TelemetryStore();

    expect(store.StartedAt).to.be.a('number');
    expect(store.StartedAt).to.be.at.most(Date.now());
  });

  it('record() counts the request and the response into the lifetime stats', () => {
    const store = new TelemetryStore();

    store.record('GET', '/users/:id', 200, 5);
    store.record('GET', '/users/:id', 503, 40);

    const stats = store.RequestStats.toJSON();
    expect(stats.requests).to.eq(2);
    expect(stats.responses).to.eq(2);
    expect(stats.success).to.eq(1);
    expect(stats.server_error).to.eq(1);
    expect(stats.errors).to.eq(1);
  });

  it('record() routes the response into the timeline bucket for now', () => {
    const store = new TelemetryStore();

    store.record('GET', '/x', 500, 3);

    const timeline = store.Timeline.toJSON();
    const keys = Object.keys(timeline);
    expect(keys).to.have.length(1);
    expect(Number(keys[0])).to.eq(store.Timeline.keyFor(Date.now()));
    expect(timeline[keys[0]].responses).to.eq(1);
    expect(timeline[keys[0]].server_error).to.eq(1);
  });

  it('record() keys the per-route breakdown by method and route', () => {
    const store = new TelemetryStore();

    store.record('GET', '/users/:id', 200, 5);
    store.record('GET', '/users/:id', 200, 7);
    store.record('POST', '/users/:id', 201, 9);

    const snapshot = store.RouteStats.toJSON();
    expect(snapshot.truncated).to.eq(false);
    expect(snapshot.routes).to.have.length(2);

    const get = snapshot.routes.find((r) => r.method === 'GET');
    expect(get!.route).to.eq('/users/:id');
    expect(get!.stats.requests).to.eq(2);
  });

  it('record() skips the per-route breakdown when routes are disabled', () => {
    const store = new TelemetryStore();
    store.RoutesEnabled = false;

    store.record('GET', '/users/:id', 200, 5);

    // the gate is per-route only — the lifetime stats and timeline still record
    expect(store.RouteStats.toJSON().routes).to.have.length(0);
    expect(store.RequestStats.toJSON().requests).to.eq(1);
    expect(Object.keys(store.Timeline.toJSON())).to.have.length(1);
  });
});
