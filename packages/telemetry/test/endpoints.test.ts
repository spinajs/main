import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Metrics, TelemetryMiddleware, metricsHandler, statsHandler } from './../src/index.js';

function fakeRes() {
  return {
    setHeader: sinon.spy(),
    end: sinon.spy(),
    statusCode: 200,
  };
}

describe('endpoints — metricsHandler', () => {
  it('sets the prometheus content-type and writes the rendered exposition text', async () => {
    const m = new Metrics();
    const map = m.defineMetrics('e', [{ name: 'hits', help: 'hits', type: 'counter' }]);
    (map['hits'] as any).inc(2);

    const res = fakeRes();
    await metricsHandler(m)({}, res as any);

    const ctCall = res.setHeader.getCalls().find((c) => c.args[0] === 'Content-Type');
    expect(ctCall, 'Content-Type set').to.not.be.undefined;
    expect(ctCall!.args[1]).to.contain('text/plain');

    expect(res.end.calledOnce).to.eq(true);
    const body = res.end.firstCall.args[0] as string;
    expect(body).to.contain('e_hits');
  });
});

describe('endpoints — statsHandler', () => {
  it('writes JSON with `all` + `timeline` from the middleware lifetime stats', () => {
    const mw = new TelemetryMiddleware();
    mw.RequestStats.countResponse(200, 5);
    // default bucketMs is 60_000, so ts 42_000 -> bucket key floor(42000/60000) = 0
    mw.Timeline.record(200, 5, 42_000);

    const res = fakeRes();
    statsHandler(mw)({}, res as any);

    const ctCall = res.setHeader.getCalls().find((c) => c.args[0] === 'Content-Type');
    expect(ctCall!.args[1]).to.contain('application/json');

    expect(res.end.calledOnce).to.eq(true);
    const parsed = JSON.parse(res.end.firstCall.args[0] as string);
    expect(parsed).to.have.property('all');
    expect(parsed).to.have.property('timeline');
    expect(parsed.all.responses).to.eq(1);
    expect(parsed.all.success).to.eq(1);
    expect(Object.keys(parsed.timeline)).to.deep.eq(['0']);
  });
});
