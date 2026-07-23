import 'mocha';
import { expect } from 'chai';
import { Forbidden } from '@spinajs/exceptions';

import { TelemetryTokenPolicy, PublicPolicy } from './../src/index.js';

/**
 * The policies read their token / dev flag from @Config properties and their
 * logger from @Logger. Both decorators install a getter-only property on the
 * prototype that resolves through DI, so a plain assignment throws. Rather than
 * booting a Configuration, shadow them with own data properties on the
 * instance.
 */
function stub(target: unknown, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, writable: true, configurable: true });
}

function makeTokenPolicy(token: string, isDev: boolean) {
  const p = new TelemetryTokenPolicy();
  stub(p, 'Token', token);
  stub(p, 'isDev', isDev);
  stub(p, 'Log', { warn: () => undefined });
  return p;
}

function fakeReq(headers: Record<string, string> = {}) {
  return { headers, storage: { realIp: '10.0.0.1' } } as any;
}

describe('TelemetryTokenPolicy', () => {
  it('passes in development regardless of the token', async () => {
    const p = makeTokenPolicy('secret', true);
    await p.execute(fakeReq());
  });

  it('rejects a request with no token', async () => {
    const p = makeTokenPolicy('secret', false);
    let thrown: unknown;
    try {
      await p.execute(fakeReq());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).to.be.instanceOf(Forbidden);
  });

  it('rejects a request with the wrong token', async () => {
    const p = makeTokenPolicy('secret', false);
    let thrown: unknown;
    try {
      await p.execute(fakeReq({ 'x-metrics-token': 'nope' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).to.be.instanceOf(Forbidden);
  });

  it('accepts a request with the right token on the x-metrics-token header', async () => {
    const p = makeTokenPolicy('secret', false);
    await p.execute(fakeReq({ 'x-metrics-token': 'secret' }));
  });

  it('is always enabled', () => {
    expect(makeTokenPolicy('secret', false).isEnabled(null as any, null as any)).to.eq(true);
  });
});

describe('PublicPolicy', () => {
  it('always resolves', async () => {
    await new PublicPolicy().execute(fakeReq());
  });

  it('is always enabled', () => {
    expect(new PublicPolicy().isEnabled(null as any, null as any)).to.eq(true);
  });
});
