import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { TelemetryMiddleware } from './../src/index.js';

/**
 * The middleware lazily resolves Metrics via DI on first use. To keep this a
 * pure unit test ( no DI / server ), we pre-seed the metric fields with spies
 * and mark it already-defined so ensureMetrics() short-circuits.
 */
function makeMiddleware() {
  const mw = new TelemetryMiddleware();

  const inc = sinon.spy();
  const observe = sinon.spy();
  const gaugeInc = sinon.spy();
  const gaugeDec = sinon.spy();

  const anyMw = mw as any;
  anyMw.defined = true;
  anyMw.requestsTotal = { inc };
  anyMw.requestDuration = { observe };
  anyMw.inFlight = { inc: gaugeInc, dec: gaugeDec };

  return { mw, spies: { inc, observe, gaugeInc, gaugeDec } };
}

function fakeReq(overrides: Record<string, unknown> = {}) {
  return { storage: {}, method: 'GET', path: '/x', ...overrides } as any;
}

describe('TelemetryMiddleware — before()/after() handlers', () => {
  it('before() stamps the start time and increments the in-flight gauge', () => {
    const { mw, spies } = makeMiddleware();
    const req = fakeReq();
    const next = sinon.spy();

    mw.before()(req, {} as any, next);

    expect(req.storage.__telemetryStart).to.not.be.undefined;
    expect(typeof req.storage.__telemetryStart).to.eq('bigint');
    expect(spies.gaugeInc.calledOnce).to.eq(true);
    expect(next.calledOnce).to.eq(true);
  });

  it('after() observes the histogram once, increments the counter with {method,route,status}, and decrements in-flight', () => {
    const { mw, spies } = makeMiddleware();
    const req = fakeReq({ route: { path: '/users/:id' } });
    const res = { statusCode: 200 } as any;

    mw.before()(req, res, sinon.spy());
    mw.after()(req, res, sinon.spy());

    expect(spies.observe.calledOnce).to.eq(true);
    expect(spies.inc.calledOnce).to.eq(true);

    const labels = spies.inc.firstCall.args[0];
    expect(labels).to.deep.eq({ method: 'GET', route: '/users/:id', status: '200' });

    // in-flight balanced: inc in before(), dec in after()
    expect(spies.gaugeInc.calledOnce).to.eq(true);
    expect(spies.gaugeDec.calledOnce).to.eq(true);
  });

  it('after() feeds the lifetime RequestStats and Timeline', () => {
    const { mw } = makeMiddleware();
    const req = fakeReq();
    const res = { statusCode: 503 } as any;

    mw.before()(req, res, sinon.spy());
    mw.after()(req, res, sinon.spy());

    const stats = mw.RequestStats.toJSON();
    expect(stats.responses).to.eq(1);
    expect(stats.server_error).to.eq(1);
    expect(stats.errors).to.eq(1);

    const tl = mw.Timeline.toJSON();
    expect(Object.keys(tl).length).to.eq(1);
    const bucket = tl[Object.keys(tl)[0]];
    expect(bucket.responses).to.eq(1);
    expect(bucket.server_error).to.eq(1);
  });

  it('falls back to req.path when no matched route is available', () => {
    const { mw, spies } = makeMiddleware();
    const req = fakeReq({ path: '/raw' });
    const res = { statusCode: 404 } as any;

    mw.before()(req, res, sinon.spy());
    mw.after()(req, res, sinon.spy());

    expect(spies.inc.firstCall.args[0]).to.deep.include({ route: '/raw', status: '404' });
  });

  it('Order sits after req.storage-establishing middlewares', () => {
    const { mw } = makeMiddleware();
    expect(mw.Order).to.eq(2);
  });
});
