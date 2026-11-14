import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import type { IFinishContext, IMiddlewareContext } from '@spinajs/http';

import { TelemetryMiddleware, TelemetryStore } from './../src/index.js';

/**
 * The middleware lazily resolves Metrics via DI on first use and takes its
 * store by `@Autoinject`. To keep this a pure unit test ( no DI / server ), we
 * pre-seed the metric fields with spies, mark it already-defined so
 * ensureMetrics() short-circuits, and hand it a DI-less store.
 */
function makeMiddleware<T extends TelemetryMiddleware>(mw: T = new TelemetryMiddleware() as T) {
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

function fakeRes(statusCode = 200) {
  return { statusCode } as any;
}

function context(req: any, res: any, extra: Partial<IMiddlewareContext> = {}): IMiddlewareContext {
  return { req, res, storage: req.storage, ...extra };
}

function finished(ctx: IMiddlewareContext, aborted = false): IFinishContext {
  return { ...ctx, aborted };
}

describe('TelemetryMiddleware — onBefore / onFinish', () => {
  it('onBefore stamps the start time and increments in-flight', () => {
    const { mw, spies } = makeMiddleware();
    const req = fakeReq();

    mw.onBefore(context(req, fakeRes()));

    expect(typeof req.storage.__telemetryStart).to.eq('bigint');
    expect(spies.gaugeInc.calledOnce).to.eq(true);
  });

  it('records nothing until the request finishes', () => {
    const { mw, store, spies } = makeMiddleware();

    mw.onBefore(context(fakeReq(), fakeRes()));

    expect(spies.inc.called).to.eq(false);
    expect(spies.observe.called).to.eq(false);
    expect(store.RequestStats.toJSON().requests).to.eq(0);
  });

  it('on finish observes the histogram once, increments the counter with {method,route,status}, and decrements in-flight', () => {
    const { mw, spies } = makeMiddleware();
    const req = fakeReq();
    const res = fakeRes(200);
    const ctx = context(req, res);

    mw.onBefore(ctx);
    // A server middleware gets the matched route only once routing ran: in onAfter and onFinish.
    mw.onFinish(finished({ ...ctx, path: 'http:GET /users/:id' }));

    expect(spies.observe.calledOnce).to.eq(true);
    expect(spies.inc.calledOnce).to.eq(true);
    expect(spies.inc.firstCall.args[0]).to.deep.eq({ method: 'GET', route: '/users/:id', status: '200' });
    expect(spies.gaugeInc.calledOnce).to.eq(true);
    expect(spies.gaugeDec.calledOnce).to.eq(true);
  });

  it('labels with the mounted route path of the context before the express route', () => {
    const { mw, spies } = makeMiddleware();
    const req = fakeReq({ route: { path: '/express/:id' } });
    const ctx = context(req, fakeRes());

    mw.onBefore(ctx);
    mw.onFinish(finished({ ...ctx, path: 'http:GET /users/:id' }));

    expect(spies.inc.firstCall.args[0]).to.deep.include({ route: '/users/:id' });
  });

  it('falls back to the express route, then req.path, when the request matched no route', () => {
    const { mw, spies } = makeMiddleware();

    const routed = context(fakeReq({ route: { path: '/users/:id' } }), fakeRes());
    mw.onBefore(routed);
    mw.onFinish(finished(routed));

    const raw = context(fakeReq({ path: '/raw' }), fakeRes(404));
    mw.onBefore(raw);
    mw.onFinish(finished(raw));

    expect(spies.inc.firstCall.args[0]).to.deep.include({ route: '/users/:id' });
    expect(spies.inc.secondCall.args[0]).to.deep.include({ route: '/raw', status: '404' });
  });

  it('ignores req.storage.route', () => {
    const { mw, spies } = makeMiddleware();
    const ctx = context(fakeReq({ path: '/raw', storage: { route: '/stored' } }), fakeRes());

    mw.onBefore(ctx);
    mw.onFinish(finished(ctx));

    expect(spies.inc.firstCall.args[0]).to.deep.include({ route: '/raw' });
  });

  it('reads the status at finish, not the one the request started with', () => {
    const { mw, store, spies } = makeMiddleware();
    const res = fakeRes(200);
    const ctx = context(fakeReq(), res);

    mw.onBefore(ctx);
    res.statusCode = 404;
    mw.onFinish(finished(ctx));

    expect(spies.inc.firstCall.args[0]).to.deep.include({ status: '404' });
    expect(store.RequestStats.toJSON().client_error).to.eq(1);
  });

  it('feeds the shared store on finish', () => {
    const { mw, store } = makeMiddleware();
    const ctx = context(fakeReq(), fakeRes(503), { path: 'http:GET /users/:id' });

    mw.onBefore(ctx);
    mw.onFinish(finished(ctx));

    const stats = store.RequestStats.toJSON();
    expect(stats.responses).to.eq(1);
    expect(stats.server_error).to.eq(1);

    const snapshot = store.RouteStats.toJSON();
    expect(snapshot.routes).to.have.length(1);
    expect(snapshot.routes[0].method).to.eq('GET');
    expect(snapshot.routes[0].route).to.eq('/users/:id');

    expect(Object.keys(store.Timeline.toJSON())).to.have.length(1);
  });

  it('balances in-flight and records nothing else when the client aborted', () => {
    const { mw, store, spies } = makeMiddleware();
    const ctx = context(fakeReq(), fakeRes(200));

    mw.onBefore(ctx);
    mw.onFinish(finished(ctx, true));

    expect(spies.gaugeInc.calledOnce).to.eq(true);
    expect(spies.gaugeDec.calledOnce).to.eq(true);

    // res.statusCode is the un-sent default here: counting it would pollute the status classes, the route stats and
    // the timeline.
    expect(spies.inc.called, 'no request counter on an aborted request').to.eq(false);
    expect(spies.observe.called, 'no duration observation on an aborted request').to.eq(false);

    const stats = store.RequestStats.toJSON();
    expect(stats.requests).to.eq(0);
    expect(stats.responses).to.eq(0);
    expect(store.RouteStats.toJSON().routes).to.have.length(0);
    expect(Object.keys(store.Timeline.toJSON())).to.have.length(0);
  });

  it('records nothing and leaves the gauge alone for a request it did not start', () => {
    const { mw, store, spies } = makeMiddleware();

    mw.onFinish(finished(context(fakeReq(), fakeRes())));
    mw.onFinish(finished(context(fakeReq(), fakeRes()), true));

    expect(spies.gaugeDec.called).to.eq(false);
    expect(spies.inc.called).to.eq(false);
    expect(store.RequestStats.toJSON().responses).to.eq(0);
  });

  it('Order sits after the http built-ins that set up the request', () => {
    const { mw } = makeMiddleware();
    expect(mw.Order).to.eq(2);
  });
});

describe('TelemetryMiddleware — subclasses', () => {
  it('a record() override that calls super sees the finished request; the gauge is balanced either way', () => {
    const seen: number[] = [];
    class Counting extends TelemetryMiddleware {
      protected record(ctx: IFinishContext): void {
        super.record(ctx);
        seen.push(ctx.res.statusCode);
      }
    }
    class Silent extends TelemetryMiddleware {
      protected record(): void {}
    }

    const counting = makeMiddleware(new Counting());
    const ctx = context(fakeReq(), fakeRes(429));
    counting.mw.onBefore(ctx);
    counting.mw.onFinish(finished(ctx));
    expect(seen).to.deep.eq([429]);
    expect(counting.spies.inc.calledOnce).to.eq(true);

    const silent = makeMiddleware(new Silent());
    const other = context(fakeReq(), fakeRes());
    silent.mw.onBefore(other);
    silent.mw.onFinish(finished(other));
    expect(silent.spies.inc.called).to.eq(false);
    expect(silent.spies.gaugeDec.calledOnce).to.eq(true);
  });

  it('an onBefore override that skips super leaves the request unmeasured', () => {
    class ProbeFree extends TelemetryMiddleware {
      public onBefore(ctx: IMiddlewareContext): void {
        if (ctx.req.path === '/health') return;
        super.onBefore(ctx);
      }
    }
    const { mw, spies } = makeMiddleware(new ProbeFree());
    const ctx = context(fakeReq({ path: '/health' }), fakeRes());

    mw.onBefore(ctx);
    mw.onFinish(finished(ctx));

    expect(spies.gaugeInc.called).to.eq(false);
    expect(spies.gaugeDec.called).to.eq(false);
    expect(spies.inc.called).to.eq(false);
  });

  it('routeLabel() decides the label of the series and of the store', () => {
    class Bounded extends TelemetryMiddleware {
      protected routeLabel(ctx: IMiddlewareContext): string {
        return ctx.path ? super.routeLabel(ctx) : '__unmatched__';
      }
    }
    const { mw, spies, store } = makeMiddleware(new Bounded());
    const ctx = context(fakeReq({ path: '/scan/1' }), fakeRes(404));

    mw.onBefore(ctx);
    mw.onFinish(finished(ctx));

    expect(spies.inc.firstCall.args[0]).to.deep.include({ route: '__unmatched__' });
    expect(store.RouteStats.toJSON().routes[0].route).to.eq('__unmatched__');
  });
});

describe('TelemetryMiddleware — never breaks the request', () => {
  it('swallows a throw in onBefore and then leaves the gauge alone at finish', () => {
    const { mw, spies } = makeMiddleware();
    (mw as any).inFlight = {
      inc: () => {
        throw new Error('boom');
      },
      dec: spies.gaugeDec,
    };
    const ctx = context(fakeReq(), fakeRes());

    expect(() => mw.onBefore(ctx)).to.not.throw();
    mw.onFinish(finished(ctx));

    expect(spies.gaugeDec.called).to.eq(false);
  });

  it('swallows a throwing metric on finish', () => {
    const { mw } = makeMiddleware();
    (mw as any).requestDuration = {
      observe: () => {
        throw new Error('boom');
      },
    };
    const ctx = context(fakeReq(), fakeRes(200));

    mw.onBefore(ctx);
    expect(() => mw.onFinish(finished(ctx))).to.not.throw();
  });

  it('still balances the in-flight gauge when a later metric throws', () => {
    const { mw, spies } = makeMiddleware();
    (mw as any).requestsTotal = {
      inc: () => {
        throw new Error('boom');
      },
    };
    const ctx = context(fakeReq(), fakeRes(200));

    mw.onBefore(ctx);
    mw.onFinish(finished(ctx));

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
    const ctx = context(fakeReq(), fakeRes(200));

    mw.onBefore(ctx);
    expect(() => mw.onFinish(finished(ctx))).to.not.throw();
  });

  it('swallows a throwing record() override', () => {
    class Throwing extends TelemetryMiddleware {
      protected record(): void {
        throw new Error('boom');
      }
    }
    const { mw, spies } = makeMiddleware(new Throwing());
    const ctx = context(fakeReq(), fakeRes(200));

    mw.onBefore(ctx);
    expect(() => mw.onFinish(finished(ctx))).to.not.throw();
    expect(spies.gaugeDec.calledOnce).to.eq(true);
  });
});
