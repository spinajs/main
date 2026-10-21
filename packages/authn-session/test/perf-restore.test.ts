import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Perf, PerfSink } from '@spinajs/log-common';
import type { IPerfMetric } from '@spinajs/log-common';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';
import { DefaultSessionIssuer, MemorySessionStore } from '../src/index.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const alice: IdentityRef = { type: 'user', id: 'alice' };
const facts = (): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
const SESSION_CONFIG = { authn: { session: { service: 'MemorySessionStore', expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 }, pendingTtlSeconds: 300 } } };

const RESTORE = 'authn.session.restore';

class CapturingSink extends PerfSink {
  static metrics: IPerfMetric[] = [];
  public collect(metric: IPerfMetric): void {
    CapturingSink.metrics.push(metric);
  }
}

describe('DefaultSessionIssuer perf metrics', () => {
  async function setup() {
    await withSessionConfig(SESSION_CONFIG, [DefaultSessionIssuer, SessionIssuer]);
    const issuer = await DI.resolve(DefaultSessionIssuer);
    await (await DI.resolve(MemorySessionStore)).truncate();
    return issuer;
  }

  beforeEach(() => {
    CapturingSink.metrics = [];
    Perf.Enabled = true;
    DI.register(CapturingSink).as(PerfSink);
    Perf.refreshSinks();
  });

  afterEach(() => {
    DI.unregister(PerfSink, CapturingSink);
    Perf.refreshSinks();
    Perf.Enabled = true;
    uncacheOwned([DefaultSessionIssuer, SessionIssuer]);
  });

  it('times a restore once as a span', async () => {
    const issuer = await setup();
    const h = await issuer.issue(alice, facts());
    CapturingSink.metrics = [];

    expect(await issuer.restore(h.id)).to.not.be.null;

    expect(CapturingSink.metrics.map((m) => m.name)).to.deep.equal([RESTORE]);
    expect(CapturingSink.metrics[0].kind).to.equal('span');
    expect(CapturingSink.metrics[0].durationMs).to.be.a('number');
  });

  it('times a restore that finds no session', async () => {
    const issuer = await setup();

    expect(await issuer.restore('unknown-session-id')).to.be.null;

    expect(CapturingSink.metrics.map((m) => m.name)).to.deep.equal([RESTORE]);
  });

  it('times a peek once, as the restore it runs', async () => {
    const issuer = await setup();
    const h = await issuer.issue(alice, facts());
    CapturingSink.metrics = [];

    await issuer.peek(h.id);

    expect(CapturingSink.metrics.map((m) => m.name)).to.deep.equal([RESTORE]);
  });

  it('emits nothing when Perf is disabled', async () => {
    const issuer = await setup();
    const h = await issuer.issue(alice, facts());
    CapturingSink.metrics = [];
    Perf.Enabled = false;

    await issuer.restore(h.id);

    expect(CapturingSink.metrics).to.have.length(0);
  });
});
