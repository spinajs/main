import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { RequestId } from '../src/middlewares/RequestId.js';
import { Request as sRequest } from '../src/interfaces.js';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const INBOUND_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_SPAN_ID = '00f067aa0ba902b7';
const INBOUND_TRACEPARENT = `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`;

// The middleware constructor is dependency-free, so we exercise the handler
// returned by before() directly against fake req/res rather than standing up a
// full DI server.
function fakeReq(headers: Record<string, string> = {}): sRequest {
  return { headers, storage: {} } as unknown as sRequest;
}

function fakeRes() {
  return { header: sinon.stub() } as any;
}

describe('RequestId middleware — traceparent seeding', () => {
  it('with an inbound traceparent, continues the trace ( same traceId, fresh spanId ) and sets requestId', () => {
    const mw = new RequestId();
    const req = fakeReq({ traceparent: INBOUND_TRACEPARENT });
    const res = fakeRes();
    const next = sinon.spy();

    mw.before()(req, res, next);

    expect(req.storage.requestId).to.be.a('string').and.not.empty;
    expect(req.storage.traceId).to.eq(INBOUND_TRACE_ID);
    expect(req.storage.spanId).to.match(HEX16);
    expect(req.storage.spanId).to.not.eq(INBOUND_SPAN_ID);
    expect(next.calledOnce).to.eq(true);
  });

  it('with no traceparent header, starts a new trace ( generated traceId + spanId )', () => {
    const mw = new RequestId();
    const req = fakeReq({});
    const res = fakeRes();
    const next = sinon.spy();

    mw.before()(req, res, next);

    expect(req.storage.requestId).to.be.a('string').and.not.empty;
    expect(req.storage.traceId).to.match(HEX32);
    expect(req.storage.spanId).to.match(HEX16);
    expect(next.calledOnce).to.eq(true);
  });

  it('emits an outbound traceparent response header carrying the seeded ids', () => {
    const mw = new RequestId();
    const req = fakeReq({ traceparent: INBOUND_TRACEPARENT });
    const res = fakeRes();

    mw.before()(req, res, sinon.spy());

    const call = (res.header as sinon.SinonStub).getCalls().find((c) => c.args[0] === 'traceparent');
    expect(call, 'traceparent header set').to.not.be.undefined;
    expect(call!.args[1]).to.eq(`00-${INBOUND_TRACE_ID}-${req.storage.spanId}-01`);
  });

  it('before() sets x-request-id header, after() is disabled', () => {
    const mw = new RequestId();
    const req = fakeReq();
    const res = fakeRes();

    mw.before()(req, res, sinon.spy());

    // after() never runs for matched controller routes, so the header MUST be
    // emitted in before() — from the freshly generated storage.requestId.
    expect((res.header as sinon.SinonStub).calledWith('x-request-id', req.storage.requestId)).to.eq(true);
    expect(mw.after()).to.eq(null);
  });
});
