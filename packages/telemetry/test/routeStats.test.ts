import 'mocha';
import { expect } from 'chai';

import { RouteStats } from './../src/routeStats.js';

describe('RouteStats', () => {
  it('accumulates per method+route', () => {
    const rs = new RouteStats(100, 25);

    rs.record('GET', '/users/:id', 200, 10);
    rs.record('GET', '/users/:id', 500, 30);
    rs.record('POST', '/users', 201, 5);

    const snapshot = rs.toJSON();
    expect(snapshot.routes).to.have.length(2);

    const users = snapshot.routes.find((r) => r.method === 'GET' && r.route === '/users/:id');
    expect(users!.stats.requests).to.eq(2);
    expect(users!.stats.responses).to.eq(2);
    expect(users!.stats.errors).to.eq(1);
    expect(users!.stats.server_error).to.eq(1);
    expect(users!.stats.success).to.eq(1);
    expect(users!.stats.avg_time).to.eq(20);
    expect(users!.stats.max_time).to.eq(30);
    expect(users!.stats.min_time).to.eq(10);

    const post = snapshot.routes.find((r) => r.method === 'POST');
    expect(post!.stats.requests).to.eq(1);
  });

  it('separates the same route on different methods', () => {
    const rs = new RouteStats(100, 25);
    rs.record('GET', '/x', 200, 1);
    rs.record('DELETE', '/x', 200, 1);
    expect(rs.toJSON().routes).to.have.length(2);
  });

  it('stops adding new keys past maxEntries and reports truncation', () => {
    const rs = new RouteStats(2, 25);

    rs.record('GET', '/a', 200, 1);
    rs.record('GET', '/b', 200, 1);
    rs.record('GET', '/c', 200, 1);

    expect(rs.Truncated).to.eq(true);
    expect(rs.toJSON().truncated).to.eq(true);
    expect(rs.toJSON().routes).to.have.length(2);
  });

  it('keeps counting into existing keys after the cap is hit', () => {
    const rs = new RouteStats(1, 25);

    rs.record('GET', '/a', 200, 1);
    rs.record('GET', '/b', 200, 1);
    rs.record('GET', '/a', 200, 3);

    const a = rs.toJSON().routes.find((r) => r.route === '/a');
    expect(a!.stats.requests).to.eq(2);
  });

  it('propagates the apdex threshold into each bucket', () => {
    const rs = new RouteStats(100, 10);
    rs.record('GET', '/a', 200, 5);
    rs.record('GET', '/a', 200, 500);

    const a = rs.toJSON().routes.find((r) => r.route === '/a');
    expect(a!.stats.apdex_satisfied).to.eq(1);
    expect(a!.stats.apdex_tolerated).to.eq(0);
  });
});
