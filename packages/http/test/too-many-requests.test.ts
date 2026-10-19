import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { BadRequestResponse, HTTP_STATUS_CODE, HttpAcceptHeaders, TooManyRequests, retryAfterHeader } from '../src/index.js';
import { configurationOf } from './support/config-boot.js';

interface ISent {
  status?: number;
  headers: Record<string, unknown>;
  body?: unknown;
}

async function send(response: TooManyRequests): Promise<ISent> {
  const sent: ISent = { headers: {} };
  const req = { headers: {}, accepts: (offered: string[]) => offered[0] } as any;
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    setHeader(name: string, value: unknown) {
      sent.headers[name] = value;
    },
    set() {
      return this;
    },
    cookie() {},
    send(body?: unknown) {
      sent.body = body;
    },
  } as any;
  const fn = await response.execute(req, res);
  if (fn) fn(req, res);
  return sent;
}

describe('TooManyRequests', () => {
  // XML: a JSON error answer would go through the DataTransformer collection, which depends on the rest of the run.
  const SpecConfiguration = configurationOf({ http: { AcceptHeaders: HttpAcceptHeaders.XML } });

  before(async () => {
    DI.uncache(Configuration);
    DI.register(SpecConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  after(() => {
    DI.unregister(SpecConfiguration);
    DI.uncache(SpecConfiguration);
    DI.uncache(Configuration);
  });

  it('answers 429 with Retry-After rounded up, after the given headers', async () => {
    const sent = await send(new TooManyRequests({ error: 'throttled' }, { retryAfterSeconds: 1.2, Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] }));
    expect(sent.status).to.eq(HTTP_STATUS_CODE.TOO_MANY_REQUESTS);
    expect(sent.headers).to.deep.eq({ 'Cache-Control': 'no-store', 'Retry-After': '2' });
  });

  it('sends no Retry-After without a finite retryAfterSeconds', async () => {
    for (const retryAfterSeconds of [undefined, NaN, Infinity]) {
      const sent = await send(new TooManyRequests({ error: 'throttled' }, { retryAfterSeconds }));
      expect(sent.status).to.eq(HTTP_STATUS_CODE.TOO_MANY_REQUESTS);
      expect(sent.headers).to.deep.eq({});
    }
    expect((await send(new TooManyRequests(null))).status).to.eq(HTTP_STATUS_CODE.TOO_MANY_REQUESTS);
  });

  it('is a client error over its own template', () => {
    const r = new TooManyRequests(null);
    expect(r).to.be.instanceOf(BadRequestResponse);
    expect((r as any)._template).to.eq('too-many-requests.pug');
  });

  it('does not leak retryAfterSeconds into the response options', () => {
    expect((new TooManyRequests(null, { retryAfterSeconds: 3 }) as any).options).to.deep.eq({ Headers: [{ Name: 'Retry-After', Value: '3' }] });
  });
});

describe('retryAfterHeader', () => {
  it('rounds up and never goes below 0', () => {
    expect(retryAfterHeader(30)).to.deep.eq({ Name: 'Retry-After', Value: '30' });
    expect(retryAfterHeader(0.01)).to.deep.eq({ Name: 'Retry-After', Value: '1' });
    expect(retryAfterHeader(0)).to.deep.eq({ Name: 'Retry-After', Value: '0' });
    expect(retryAfterHeader(-5)).to.deep.eq({ Name: 'Retry-After', Value: '0' });
  });
});
