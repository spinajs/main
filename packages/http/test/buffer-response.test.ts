import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { InvalidArgument } from '@spinajs/exceptions';
import { BufferResponse, HTTP_STATUS_CODE } from '../src/index.js';

const BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

function fakeRes() {
  const res: any = { statusCode: undefined, headers: {} as Record<string, string>, body: undefined };
  res.status = sinon.stub().callsFake((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.set = sinon.stub().callsFake((k: string, v: string) => {
    res.headers[k] = v;
    return res;
  });
  res.setHeader = res.set;
  res.send = sinon.stub().callsFake((b: unknown) => {
    res.body = b;
    return res;
  });
  return res;
}

async function run(r: BufferResponse) {
  const res = fakeRes();
  const fn = await r.execute({} as any, res);
  (fn as (a: any, b: any) => void)({} as any, res);
  return res;
}

describe('BufferResponse', () => {
  it('sends the bytes unchanged with the given mime type and status 200', async () => {
    const res = await run(new BufferResponse(BYTES, 'image/png'));

    expect(res.statusCode).to.eq(200);
    expect(res.headers['Content-Type']).to.eq('image/png');
    expect(Buffer.compare(res.body, BYTES)).to.eq(0);
  });

  it('accepts a Uint8Array view without copying the surrounding buffer', async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const res = await run(new BufferResponse(backing.subarray(2, 5), 'application/octet-stream'));

    expect(Array.from(res.body as Buffer)).to.deep.eq([1, 2, 3]);
  });

  it('honours StatusCode and custom headers, and lets the mime type win over a Content-Type header', async () => {
    const res = await run(
      new BufferResponse(BYTES, 'image/png', {
        StatusCode: HTTP_STATUS_CODE.CREATED,
        Headers: [
          { Name: 'Cache-Control', Value: 'no-store' },
          { Name: 'Content-Type', Value: 'text/plain' },
        ],
      }),
    );

    expect(res.statusCode).to.eq(201);
    expect(res.headers['Cache-Control']).to.eq('no-store');
    expect(res.headers['Content-Type']).to.eq('image/png');
  });

  it('does not touch cookies when Coockies is empty or absent', async () => {
    for (const options of [undefined, { Coockies: [] }]) {
      const res = fakeRes();
      res.cookie = sinon.stub();
      const fn = await new BufferResponse(BYTES, 'image/png', options).execute({} as any, res);
      (fn as (a: any, b: any) => void)({} as any, res);

      expect(res.cookie.called).to.be.false;
      expect(res.send.calledOnce).to.be.true;
    }
  });

  it('rejects non-binary input and an empty mime type', () => {
    expect(() => new BufferResponse('abc' as any, 'image/png')).to.throw(InvalidArgument);
    expect(() => new BufferResponse(BYTES, '')).to.throw(InvalidArgument);
  });
});
