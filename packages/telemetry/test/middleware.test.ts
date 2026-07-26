import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { TelemetryMiddleware, TelemetryStore } from './../src/index.js';

/**
 * The middleware lazily resolves Metrics via DI on first use and takes its
 * store by `@Autoinject`. To keep this a pure unit test ( no DI / server ), we
 * pre-seed the metric fields with spies, mark it already-defined so
 * ensureMetrics() short-circuits, and hand it a DI-less store.
 */
function makeMiddleware() {
  const mw = new TelemetryMiddleware();
  const store = new TelemetryStore();

  const inc = sinon.spy();
  const observe = sinon.spy();
  const gaugeInc = sinon.spy();
  const gaugeDec = sinon.spy();

  const anyMw = mw as any;
  anyMw.defined = true;
  anyMw.requestsTotal = { inc };
  anyMw.requestDuration = { observe };
  anyMw.inFlight = { inc: gaugeInc, dec: gaugeDec };
  anyMw.Store = store;

  return { mw, store, spies: { inc, observe, gaugeInc, gaugeDec } };
}

function fakeReq(overrides: Record<string, unknown> = {}) {
  return { storage: {}, method: 'GET', path: '/x', ...overrides } as any;
}

/**
 * A response that captures the `finish` listener the middleware registers, so a
 * test can fire it the way node does once the response is flushed.
 */
function fakeRes(statusCode = 200) {
  const listeners: Record<string, Array<() => void>> = {};

  return {
    statusCode,
    on(event: string, handler: () => void) {
      (listeners[event] ??= []).push(handler);
      return this;
    },
    finish() {
      for (const handler of listeners['finish'] ?? []) handler();
    },
    /**
     * Node emits 'close' on every response — after 'finish' when the response
     * was flushed, INSTEAD of it when the client went away mid-response.
     */
    close() {
      for (const handler of listeners['close'] ?? []) handler();
    },
    listenerCount(event: string) {
      return (listeners[event] ?? []).length;
    },
  } as any;
}

describe('TelemetryMiddleware — before() / finish handler', () => {
  it('before() stamps the start time, increments in-flight and registers a finish listener', () => {
    const { mw, spies } = makeMiddleware();
    const req = fakeReq();
    const res = fakeRes();
    const next = sinon.spy();

    mw.before()(req, res, next);

    expect(req.storage.__telemetryStart).to.not.be.undefined;
    expect(typeof req.storage.__telemetryStart).to.eq('bigint');
    expect(spies.gaugeInc.calledOnce).to.eq(true);
    expect(res.listenerCount('finish')).to.eq(1);
    expect(next.calledOnce).to.eq(true);
  });

  it('records nothing until the response actually finishes', () => {
    const { mw, store, spies } = makeMiddleware();

    mw.before()(fakeReq(), fakeRes(), sinon.spy());

    expect(spies.inc.called).to.eq(false);
    expect(spies.observe.called).to.eq(false);
    expect(store.RequestStats.toJSON().requests).to.eq(0);
  });

  it('after() is null — express never reaches it for a matched route', () => {
    const { mw } = makeMiddleware();

    expect(mw.after()).to.eq(null);
  });

  it('on finish observes the histogram once, increments the counter with {method,route,status}, and decrements in-flight', () => {
    const { mw, spies } = makeMiddleware();
    const req = fakeReq();
    const res = fakeRes(200);

    mw.before()(req, res, sinon.spy());

    // the router only populates req.route once it has matched, which is AFTER
    // before() ran — so the route label must be read in the finish handler
    req.route = { path: '/users/:id' };
    res.finish();

    expect(spies.observe.calledOnce).to.eq(true);
    expect(spies.inc.calledOnce).to.eq(true);
    expect(spies.inc.firstCall.args[0]).to.deep.eq({ method: 'GET', route: '/users/:id', status: '200' });

    // in-flight balanced: inc in before(), dec on finish
    expect(spies.gaugeInc.calledOnce).to.eq(true);
    expect(spies.gaugeDec.calledOnce).to.eq(true);
  });

  it('reads the status set after before() ran, not the one it started with', () => {
    const { mw, store, spies } = makeMiddleware();
    const req = fakeReq();
    const res = fakeRes(200);

    mw.before()(req, res, sinon.spy());
    res.statusCode = 404;
    res.finish();

    expect(spies.inc.firstCall.args[0]).to.deep.include({ status: '404' });
    expect(store.RequestStats.toJSON().client_error).to.eq(1);
  });

  it('feeds the shared store on finish', () => {
    const { mw, store } = makeMiddleware();
    const req = fakeReq({ route: { path: '/users/:id' } });
    const res = fakeRes(503);

    mw.before()(req, res, sinon.spy());
    res.finish();

    const stats = store.RequestStats.toJSON();
    expect(stats.responses).to.eq(1);
    expect(stats.server_error).to.eq(1);

    const snapshot = store.RouteStats.toJSON();
    expect(snapshot.routes).to.have.length(1);
    expect(snapshot.routes[0].method).to.eq('GET');
    expect(snapshot.routes[0].route).to.eq('/users/:id');

    expect(Object.keys(store.Timeline.toJSON())).to.have.length(1);
  });

  it('falls back to req.path when no matched route is available', () => {
    const { mw, spies } = makeMiddleware();
    const req = fakeReq({ path: '/raw' });
    const res = fakeRes(404);

    mw.before()(req, res, sinon.spy());
    res.finish();

    expect(spies.inc.firstCall.args[0]).to.deep.include({ route: '/raw', status: '404' });
  });

  it('balances in-flight when the client aborts and only close fires', () => {
    const { mw, store, spies } = makeMiddleware();
    const req = fakeReq();

    // A response node never got to send: the status is still the un-sent default.
    const res = fakeRes(200);

    mw.before()(req, res, sinon.spy());
    res.close();

    // the gauge is back where it started — this is the leak the close arm fixes
    expect(spies.gaugeInc.calledOnce).to.eq(true);
    expect(spies.gaugeDec.calledOnce).to.eq(true);

    // ...and NOTHING else was recorded: res.statusCode here is the default, not a
    // status that was ever sent, so counting it would pollute the status classes,
    // the route stats and the timeline.
    expect(spies.inc.called, 'no request counter on an aborted request').to.eq(false);
    expect(spies.observe.called, 'no duration observation on an aborted request').to.eq(false);

    const stats = store.RequestStats.toJSON();
    expect(stats.requests).to.eq(0);
    expect(stats.responses).to.eq(0);
    expect(stats.success).to.eq(0);
    expect(store.RouteStats.toJSON().routes).to.have.length(0);
    expect(Object.keys(store.Timeline.toJSON())).to.have.length(0);
  });

  it('decrements in-flight exactly once when close follows finish, as node emits it', () => {
    const { mw, store, spies } = makeMiddleware();
    const req = fakeReq({ route: { path: '/users/:id' } });
    const res = fakeRes(200);

    mw.before()(req, res, sinon.spy());
    res.finish();
    res.close();

    expect(spies.gaugeInc.calledOnce).to.eq(true);
    expect(spies.gaugeDec.calledOnce, 'close must not double-decrement after finish').to.eq(true);

    // the finish-path recording still happened, exactly once
    expect(spies.inc.calledOnce).to.eq(true);
    expect(store.RequestStats.toJSON().responses).to.eq(1);
  });

  it('records nothing twice when the same response finishes more than once', () => {
    const { mw, store, spies } = makeMiddleware();
    const res = fakeRes(200);

    mw.before()(fakeReq(), res, sinon.spy());
    res.finish();
    res.finish();

    expect(spies.gaugeDec.calledOnce).to.eq(true);
    expect(spies.inc.calledOnce).to.eq(true);
    expect(store.RequestStats.toJSON().responses).to.eq(1);
  });

  it('Order sits after req.storage-establishing middlewares', () => {
    const { mw } = makeMiddleware();
    expect(mw.Order).to.eq(2);
  });
});

describe('TelemetryMiddleware — never breaks the request', () => {
  it('still calls next() when before() throws', () => {
    const { mw } = makeMiddleware();
    (mw as any).inFlight = {
      inc: () => {
        throw new Error('boom');
      },
    };

    const next = sinon.spy();
    mw.before()(fakeReq(), fakeRes(), next);

    expect(next.calledOnce).to.eq(true);
  });

  it('swallows a throwing metric on finish rather than letting it escape the response event', () => {
    const { mw } = makeMiddleware();
    (mw as any).requestDuration = {
      observe: () => {
        throw new Error('boom');
      },
    };

    const req = fakeReq();
    const res = fakeRes(200);
    mw.before()(req, res, sinon.spy());

    // an unhandled throw here would crash the process — 'finish' has no catcher
    expect(() => res.finish()).to.not.throw();
  });

  it('still balances the in-flight gauge when a later metric throws', () => {
    const { mw, spies } = makeMiddleware();
    (mw as any).requestsTotal = {
      inc: () => {
        throw new Error('boom');
      },
    };

    const req = fakeReq();
    const res = fakeRes(200);
    mw.before()(req, res, sinon.spy());
    res.finish();

    expect(spies.gaugeInc.calledOnce).to.eq(true);
    expect(spies.gaugeDec.calledOnce).to.eq(true);
  });

  it('swallows a throwing store on finish', () => {
    const { mw } = makeMiddleware();
    (mw as any).Store = {
      record: () => {
        throw new Error('boom');
      },
    };

    const req = fakeReq();
    const res = fakeRes(200);
    mw.before()(req, res, sinon.spy());

    expect(() => res.finish()).to.not.throw();
  });
});
