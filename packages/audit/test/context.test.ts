import * as chai from 'chai';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { AmbientAuditContext, AuditContext, auditContext } from '../src/index.js';

const expect = chai.expect;
const TRACE = '0af7651916cd43dd8448eb211c80319c';

class FixedContext extends AuditContext {
  actor(): string {
    return 'service:billing';
  }
  onBehalfOf(): string | undefined {
    return undefined;
  }
  traceId(): string | undefined {
    return undefined;
  }
  origin(): string | undefined {
    return undefined;
  }
}

describe('AmbientAuditContext', () => {
  const ctx = new AmbientAuditContext();
  const run = <T>(store: Record<string, unknown>, fn: () => T): T => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).run(store, fn);

  it('takes the authz principal first, then the authn one, then the unattended one', () => {
    expect(run({ Principal: { type: 'user', id: 'u1' }, AuthnPrincipal: { type: 'user', id: 'u2' } }, () => ctx.actor())).to.eq('user:u1');
    expect(run({ AuthnPrincipal: { type: 'user', id: 7 } }, () => ctx.actor())).to.eq('user:7');
    expect(run({ AuthnPrincipal: null }, () => ctx.actor())).to.eq('unattended:unattended');
    expect(ctx.actor()).to.eq('unattended:unattended');
  });

  it('names the impersonator, else the principal acted for, else the signed-in person under runAs', () => {
    const impersonated = { type: 'user', id: 'u1', authn: { impersonator: { type: 'user', id: 'admin' } }, onBehalfOf: { type: 'user', id: 'u9' } };
    expect(run({ Principal: impersonated }, () => ctx.onBehalfOf())).to.eq('user:admin');
    expect(run({ Principal: { type: 'agent', id: 'a1', onBehalfOf: { type: 'user', id: 'u9' } } }, () => ctx.onBehalfOf())).to.eq('user:u9');
    expect(run({ Principal: { type: 'system', id: 'system' }, AuthnPrincipal: { type: 'user', id: 'u1' } }, () => ctx.onBehalfOf())).to.eq('user:u1');
    expect(run({ Principal: { type: 'user', id: 'u1' }, AuthnPrincipal: { type: 'user', id: 'u1' } }, () => ctx.onBehalfOf())).to.eq(undefined);
    expect(run({ AuthnPrincipal: { type: 'user', id: 'u1' } }, () => ctx.onBehalfOf())).to.eq(undefined);
    expect(run({ Principal: { type: 'user', id: 'u1' } }, () => ctx.onBehalfOf())).to.eq(undefined);
    expect(ctx.onBehalfOf()).to.eq(undefined);
  });

  it('keeps only a W3C trace id', () => {
    expect(run({ traceId: TRACE }, () => ctx.traceId())).to.eq(TRACE);
    expect(run({ traceId: 'not-a-trace' }, () => ctx.traceId())).to.eq(undefined);
  });

  it('takes the client address under the name authn reads, else the one http resolved', () => {
    expect(run({ ClientIp: '10.0.0.1', realIp: '10.0.0.2' }, () => ctx.origin())).to.eq('10.0.0.1');
    expect(run({ realIp: '10.0.0.2' }, () => ctx.origin())).to.eq('10.0.0.2');
    expect(ctx.origin()).to.eq(undefined);
  });

  it('leaves the links nothing publishes yet empty', () => {
    expect([ctx.tenant(), ctx.decisionId(), ctx.idempotencyKey()]).to.deep.eq([undefined, undefined, undefined]);
  });
});

describe('auditContext()', () => {
  it('answers the registered context, else the ambient one', async () => {
    expect(auditContext()).to.be.instanceOf(AmbientAuditContext);
    const snapshot = DI.RootContainer.snapshot();
    try {
      DI.register(FixedContext).as(AuditContext);
      expect(auditContext().actor()).to.eq('service:billing');
      expect(auditContext(DI.RootContainer.child()).actor()).to.eq('service:billing');
    } finally {
      await DI.RootContainer.restore(snapshot);
    }
  });
});
