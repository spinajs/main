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

function fakeReq(headers: Record<string, string> = {}): sRequest {
  return { headers, storage: {} } as unknown as sRequest;
}

function fakeRes() {
  return { header: sinon.stub() } as any;
}

const run = (mw: RequestId, req: sRequest, res: any) => mw.onBefore({ req, res, storage: req.storage });

describe('RequestId middleware — traceparent seeding', () => {
  it('with an inbound traceparent, continues the trace ( same traceId, fresh spanId ) and sets requestId', () => {
    const mw = new RequestId();
    const req = fakeReq({ traceparent: INBOUND_TRACEPARENT });
    const res = fakeRes();

    run(mw, req, res);

    expect(req.storage.requestId).to.be.a('string').and.not.empty;
    expect(req.storage.traceId).to.eq(INBOUND_TRACE_ID);
    expect(req.storage.spanId).to.match(HEX16);
    expect(req.storage.spanId).to.not.eq(INBOUND_SPAN_ID);
  });

  it('with no traceparent header, starts a new trace ( generated traceId + spanId )', () => {
    const mw = new RequestId();
    const req = fakeReq({});
    const res = fakeRes();

    run(mw, req, res);

    expect(req.storage.requestId).to.be.a('string').and.not.empty;
    expect(req.storage.traceId).to.match(HEX32);
    expect(req.storage.spanId).to.match(HEX16);
  });

  it('emits an outbound traceparent response header carrying the seeded ids', () => {
    const mw = new RequestId();
    const req = fakeReq({ traceparent: INBOUND_TRACEPARENT });
    const res = fakeRes();

    run(mw, req, res);

    const call = (res.header as sinon.SinonStub).getCalls().find((c) => c.args[0] === 'traceparent');
    expect(call, 'traceparent header set').to.not.be.undefined;
    expect(call!.args[1]).to.eq(`00-${INBOUND_TRACE_ID}-${req.storage.spanId}-01`);
  });

  it('onBefore sets the x-request-id header from the generated requestId', () => {
    const mw = new RequestId();
    const req = fakeReq();
    const res = fakeRes();

    run(mw, req, res);

    expect((res.header as sinon.SinonStub).calledWith('x-request-id', req.storage.requestId)).to.eq(true);
  });
});
