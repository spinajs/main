import 'mocha';
import { expect } from 'chai';

import { RequestStats } from './../src/index.js';

describe('RequestStats — status classes, errors, apdex', () => {
  it('counts responses by status class and total errors ( 4xx + 5xx )', () => {
    const s = new RequestStats();
    s.countResponse(100, 1);
    s.countResponse(200, 1);
    s.countResponse(204, 1);
    s.countResponse(301, 1);
    s.countResponse(404, 1);
    s.countResponse(500, 1);

    const j = s.toJSON();
    expect(j.info).to.eq(1);
    expect(j.success).to.eq(2);
    expect(j.redirect).to.eq(1);
    expect(j.client_error).to.eq(1);
    expect(j.server_error).to.eq(1);
    expect(j.responses).to.eq(6);
    expect(j.errors).to.eq(2); // 404 + 500
  });

  it('tracks min / max / avg / total response time', () => {
    const s = new RequestStats();
    s.countResponse(200, 10);
    s.countResponse(200, 30);
    s.countResponse(200, 20);

    const j = s.toJSON();
    expect(j.min_time).to.eq(10);
    expect(j.max_time).to.eq(30);
    expect(j.total_time).to.eq(60);
    expect(j.avg_time).to.eq(20);
  });

  it('apdex: fast 2xx = satisfied, medium = tolerated, slow / 5xx = neither', () => {
    // threshold 25ms -> satisfied <=25, tolerated <=100
    const s = new RequestStats(25);
    s.countResponse(200, 10); // satisfied
    s.countResponse(200, 50); // tolerated
    s.countResponse(200, 500); // frustrated ( too slow )
    s.countResponse(500, 1); // frustrated ( error, regardless of speed )

    const j = s.toJSON();
    expect(j.apdex_satisfied).to.eq(1);
    expect(j.apdex_tolerated).to.eq(1);
    // (1 + 1/2) / 4 = 0.375
    expect(j.apdex_score).to.be.closeTo(0.375, 1e-9);
  });

  it('a fast 5xx is NOT counted as satisfied ( errors are always frustrating )', () => {
    const s = new RequestStats(25);
    s.countResponse(500, 1);
    const j = s.toJSON();
    expect(j.apdex_satisfied).to.eq(0);
    expect(j.apdex_tolerated).to.eq(0);
    expect(j.apdex_score).to.eq(0);
  });

  it('apdex_score is 0 with no responses', () => {
    expect(new RequestStats().toJSON().apdex_score).to.eq(0);
  });

  it('updateRates computes per-second request / error rate over the window', () => {
    const s = new RequestStats();
    for (let i = 0; i < 10; i++) s.countRequest();
    s.countResponse(500, 1);
    s.countResponse(500, 1);

    s.updateRates(2000); // 2 second window
    const j = s.toJSON();
    expect(j.req_rate).to.eq(5); // 10 / 2s
    expect(j.err_rate).to.eq(1); // 2 / 2s
  });

  it('updateRates is safe for a zero-width window', () => {
    const s = new RequestStats();
    s.countRequest();
    s.updateRates(0);
    const j = s.toJSON();
    expect(j.req_rate).to.eq(0);
    expect(j.err_rate).to.eq(0);
  });
});
