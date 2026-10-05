import 'mocha';
import { expect } from 'chai';
import { Forbidden } from '@spinajs/exceptions';
import { testHost } from '@spinajs/authz-testing';

import { TelemetryTokenPolicy } from '../src/index.js';

const TOKEN = 'secret-token-1';

// @Config and @Logger install getter-only prototype properties; own data properties shadow them.
function stub(target: unknown, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, writable: true, configurable: true });
}

function tokenPolicy(token: unknown) {
  const p = new TelemetryTokenPolicy();
  stub(p, 'Token', token);
  stub(p, 'Log', { warn: () => undefined });
  return p;
}

const request = (headers: Record<string, string> = {}) => ({ headers, storage: { realIp: '10.0.0.1' } }) as any;

async function refusal(p: TelemetryTokenPolicy, headers: Record<string, string>): Promise<unknown> {
  try {
    await p.execute(request(headers));
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('TelemetryTokenPolicy (deprecated)', function () {
  const FLAG = ['telemetry', 'auth', 'skipInDevelopment'];
  let saved: { APP_ENV?: string; NODE_ENV?: string };

  before(async () => {
    await testHost.installHost();
  });

  after(async () => {
    await testHost.uninstallHost();
  });

  beforeEach(() => {
    saved = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    testHost.config().unset(FLAG);
  });

  it('accepts the right token on x-metrics-token', async () => {
    expect(await refusal(tokenPolicy(TOKEN), { 'x-metrics-token': TOKEN })).to.eq(undefined);
  });

  it('accepts the right token as Authorization: Bearer', async () => {
    expect(await refusal(tokenPolicy(TOKEN), { authorization: `Bearer ${TOKEN}` })).to.eq(undefined);
  });

  it('refuses a wrong token of the same length', async () => {
    expect(await refusal(tokenPolicy(TOKEN), { 'x-metrics-token': 'secret-token-2' })).to.be.instanceOf(Forbidden);
  });

  it('refuses a wrong token of another length', async () => {
    expect(await refusal(tokenPolicy(TOKEN), { 'x-metrics-token': 'secret' })).to.be.instanceOf(Forbidden);
    expect(await refusal(tokenPolicy(TOKEN), { authorization: `Bearer ${TOKEN}${TOKEN}` })).to.be.instanceOf(Forbidden);
  });

  it('refuses an empty token', async () => {
    expect(await refusal(tokenPolicy(TOKEN), { 'x-metrics-token': '' })).to.be.instanceOf(Forbidden);
    expect(await refusal(tokenPolicy(TOKEN), {})).to.be.instanceOf(Forbidden);
  });

  it('with an empty or missing configured token refuses every request, an empty header included', async () => {
    for (const configured of ['', undefined, 42]) {
      expect(await refusal(tokenPolicy(configured), { 'x-metrics-token': '' }), `configured ${String(configured)}`).to.be.instanceOf(Forbidden);
      expect(await refusal(tokenPolicy(configured), { 'x-metrics-token': 'anything' }), `configured ${String(configured)}`).to.be.instanceOf(Forbidden);
      expect(await refusal(tokenPolicy(configured), { authorization: 'Bearer anything' }), `configured ${String(configured)}`).to.be.instanceOf(Forbidden);
    }
  });

  it('does not skip the check in development without the opt-in flag', async () => {
    process.env.APP_ENV = 'development';
    expect(await refusal(tokenPolicy(TOKEN), {})).to.be.instanceOf(Forbidden);
  });

  it('does not skip the check with the opt-in flag while the env is missing', async () => {
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;
    testHost.config().set(FLAG, true);
    expect(await refusal(tokenPolicy(TOKEN), {})).to.be.instanceOf(Forbidden);
  });

  it('skips the check with the opt-in flag in an explicit development env', async () => {
    process.env.APP_ENV = 'development';
    testHost.config().set(FLAG, true);
    expect(await refusal(tokenPolicy(TOKEN), {})).to.eq(undefined);
  });
});
