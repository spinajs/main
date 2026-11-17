import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { AuditConfigError, AuditContext, AuditStore, AuditWriteFailed, audit, trailConfig } from '../src/index.js';
import type { AuditAppend, AuditReader } from '../src/index.js';
import { MemoryAuditStore, TestAuditContext } from '../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
const TRACE = '0af7651916cd43dd8448eb211c80319c';

// Stands in for a context of the caller's own, such as a driver's transaction storage.
const callers = new AsyncLocalStorage<string>();

class ProbeStore extends AuditStore {
  static seen: (string | undefined)[] = [];
  override readonly joinsTransaction = true;
  append(_write: AuditAppend): Promise<void> {
    ProbeStore.seen.push(callers.getStore());
    return Promise.resolve();
  }
  reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(undefined);
  }
}

// How a suite of another package makes the memory store fail on demand and counts the tries.
class FlakyStore extends MemoryAuditStore {
  static calls = 0;
  static down = false;
  override append(write: AuditAppend): Promise<void> {
    FlakyStore.calls += 1;
    return FlakyStore.down ? Promise.reject(new Error('store down')) : super.append(write);
  }
}

const TRAILS = {
  default: { store: 'MemoryAuditStore' },
  strict: { store: 'MemoryAuditStore', onFailure: 'reject', retry: { attempts: 3, delay: 1 }, mask: ['data.args.password'] },
  twice: { store: 'FlakyStore', onFailure: 'reject', retry: { attempts: 2, delay: '1ms' } },
  probe: { store: 'ProbeStore' },
  orphan: { store: 'NoSuchStore' },
};

describe('audit().record', function () {
  this.timeout(15000);
  let app: TestApp;

  beforeEach(async () => {
    MemoryAuditStore.reset();
    ProbeStore.seen = [];
    FlakyStore.calls = 0;
    FlakyStore.down = false;
    app = await createTestApp({
      config: { logger: SILENT, audit: { deferred: { flushMs: 20 }, trails: TRAILS } },
      register: (container) => {
        container.register(ProbeStore).as(AuditStore);
        container.register(FlakyStore).as(AuditStore);
      },
    });
  });

  afterEach(async () => {
    await app.dispose();
  });

  it('stamps the event from the request and writes it deferred on a continue trail', async () => {
    const request = { Principal: { type: 'user', id: 'u1' }, traceId: TRACE, realIp: '10.0.0.7' };
    await (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).run(request, () => audit().record({ kind: 'custom', action: 'contract.signed', subject: { type: 'contract', id: '9' }, data: { version: 2 } }));
    expect(MemoryAuditStore.events()).to.have.length(0);

    await audit().flush();
    const [event] = MemoryAuditStore.events('default');
    expect(event).to.include({ kind: 'custom', action: 'contract.signed', outcome: 'ok', actor: 'user:u1', traceId: TRACE, origin: '10.0.0.7', seq: 1 });
    expect(event.subject).to.deep.eq({ type: 'contract', id: '9' });
    expect(event.data).to.deep.eq({ version: 2 });
    expect(event.id).to.match(/^[0-9a-f-]{36}$/);
    expect(event.at).to.be.instanceOf(Date);
  });

  it('flushes the deferred buffer in the background', async () => {
    await audit().record({ kind: 'action', action: 'report.export' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(MemoryAuditStore.events().map((e) => e.action)).to.deep.eq(['report.export']);
  });

  it('writes confirmed on a reject trail, masked, before it returns', async () => {
    await audit().record({ kind: 'action', action: 'login', data: { args: { user: 'a', password: 'p' } } }, { trail: 'strict' });
    expect(MemoryAuditStore.events('strict').map((e) => e.data)).to.deep.eq([{ args: { user: 'a', password: '***' } }]);
  });

  it('retries a confirmed write', async () => {
    MemoryAuditStore.failNext(2);
    await audit().record({ kind: 'read', action: 'patient.read' }, { trail: 'strict' });
    expect(MemoryAuditStore.events('strict')).to.have.length(1);
  });

  it('counts every try, the first included, and writes an array as one append in order', async () => {
    expect(trailConfig('twice').retry).to.deep.eq({ attempts: 2, delayMs: 1 });
    FlakyStore.down = true;
    await expect(audit().record({ kind: 'read', action: 'x' }, { trail: 'twice' })).to.be.rejectedWith(AuditWriteFailed, 'audit: trail "twice" could not record 1 event(s) after 2 attempt(s)');
    expect(FlakyStore.calls).to.eq(2);

    FlakyStore.down = false;
    await audit().record(
      [
        { kind: 'read', action: 'a' },
        { kind: 'read', action: 'b' },
        { kind: 'read', action: 'c' },
      ],
      { trail: 'twice' },
    );
    expect(FlakyStore.calls).to.eq(3);
    expect(MemoryAuditStore.appends().map((a) => a.events.map((e) => e.action))).to.deep.eq([['a', 'b', 'c']]);
    expect(MemoryAuditStore.events('twice').map((e) => e.seq)).to.deep.eq([1, 2, 3]);

    MemoryAuditStore.clear();
    expect(MemoryAuditStore.events()).to.have.length(0);
  });

  it('flush() on an empty buffer settles on microtasks alone: it starts no timer', async () => {
    let settled = false;
    void audit()
      .flush()
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).to.eq(true);
  });

  it('rejects the audited operation when a reject trail cannot record', async () => {
    MemoryAuditStore.failNext(3);
    await expect(audit().record({ kind: 'read', action: 'patient.read' }, { trail: 'strict' })).to.be.rejectedWith(AuditWriteFailed, 'audit: trail "strict" could not record 1 event(s) after 3 attempt(s)');
    expect(MemoryAuditStore.events()).to.have.length(0);
  });

  it('carries on when a continue trail cannot record', async () => {
    MemoryAuditStore.failNext(3);
    await audit().record({ kind: 'action', action: 'x' }, { mode: 'confirmed' });
    expect(MemoryAuditStore.events()).to.have.length(0);
  });

  it('hands a transactional write and its transaction straight to the store', async () => {
    const transaction = { name: 'the connection of the audited write' };
    const rows = [
      { kind: 'data', action: 'insert', subject: { type: 'invoice', id: '1' } },
      { kind: 'data', action: 'insert', subject: { type: 'invoice', id: '2' } },
    ] as const;
    await audit().record(rows, { mode: 'transactional', transaction });
    expect(MemoryAuditStore.appends().map((a) => [a.transaction, a.events.length])).to.deep.eq([[transaction, 2]]);

    // Not retried (a second try would succeed here), and rejected although the trail's onFailure is 'continue'.
    MemoryAuditStore.failNext(1);
    const failed: unknown = await audit()
      .record({ kind: 'data', action: 'update' }, { mode: 'transactional', transaction })
      .catch((e: unknown) => e);
    expect(failed).to.be.instanceOf(AuditWriteFailed);
    expect(failed instanceof AuditWriteFailed && failed.inner instanceof Error ? [failed.message, failed.inner.message] : []).to.deep.eq(['audit: trail "default" could not record 1 event(s) in the transaction of the audited write', 'MemoryAuditStore: failing as asked']);
    expect(MemoryAuditStore.appends()).to.have.length(1);
    await expect(audit().record({ kind: 'data', action: 'update' }, { mode: 'transactional' })).to.be.rejectedWith(AuditConfigError, 'audit: a transactional write to trail "default" needs options.transaction');
  });

  it('refuses a transactional write to a store that cannot join the transaction', async () => {
    const write = audit().record({ kind: 'data', action: 'update' }, { trail: 'security', mode: 'transactional', transaction: {} });
    await expect(write).to.be.rejectedWith(AuditConfigError, 'audit: a transactional write to trail "security" needs a store that joins the caller\'s transaction, and LogAuditStore does not');
  });

  it('hands the connection a confirmed or a deferred write names to the store', async () => {
    await audit().record({ kind: 'action', action: 'a' }, { mode: 'confirmed', connection: 'orders' });
    await audit().record(
      [
        { kind: 'action', action: 'b' },
        { kind: 'action', action: 'c' },
      ],
      { connection: 'billing' },
    );
    await audit().record({ kind: 'action', action: 'd' });
    await audit().flush();
    expect(MemoryAuditStore.appends().map((write) => [write.connection, write.events.map((e) => e.action)])).to.deep.eq([
      ['orders', ['a']],
      ['billing', ['b', 'c']],
      [undefined, ['d']],
    ]);
  });

  it("keeps confirmed and deferred writes out of the caller's async context", async () => {
    await callers.run('caller', async () => {
      await audit().record({ kind: 'action', action: 'a' }, { trail: 'probe', mode: 'confirmed' });
      await audit().record({ kind: 'action', action: 'b' }, { trail: 'probe' });
      await audit().flush();
      await audit().record({ kind: 'data', action: 'insert' }, { trail: 'probe', mode: 'transactional', transaction: {} });
    });
    expect(ProbeStore.seen).to.deep.eq([undefined, undefined, 'caller']);
  });

  it('refuses a misconfiguration at the call', async () => {
    const input = { kind: 'action', action: 'x' } as const;
    await expect(audit().record(input, { trail: 'nope' })).to.be.rejectedWith(AuditConfigError, 'audit: no trail named "nope"');
    await expect(audit().record(input, { trail: 'orphan' })).to.be.rejectedWith(AuditConfigError, 'audit: trail "orphan" names the store "NoSuchStore", and no AuditStore is registered under that name');
    await expect(audit().record(input, { trail: 'strict', mode: 'deferred' })).to.be.rejectedWith(AuditConfigError, "audit: a deferred write cannot reject, and trail \"strict\" is written with onFailure 'reject'; use mode 'confirmed'");
    await expect(audit().record({ kind: 'action', action: '' })).to.be.rejectedWith(AuditConfigError, 'audit: action must be 1 to 128 characters');
    await expect(audit().record({ kind: 'action', action: 'x', subject: { type: 't', id: 'i'.repeat(256) } })).to.be.rejectedWith(AuditConfigError, 'audit: subject.id must be 1 to 255 characters');
  });

  it('writes out the buffer when the service is disposed', async () => {
    await audit().record({ kind: 'action', action: 'late' });
    await app.dispose();
    expect(MemoryAuditStore.events().map((e) => e.action)).to.deep.eq(['late']);
  });
});

describe('audit(container)', function () {
  this.timeout(15000);

  it("answers one service per container, which reads that container's configuration", async () => {
    MemoryAuditStore.reset();
    const config = (table: string): Record<string, unknown> => ({ logger: SILENT, audit: { trails: { own: { store: 'MemoryAuditStore', table, onFailure: 'reject' } } } });
    const a = await createTestApp({ scope: 'child', bootstrap: false, config: config('audit_a') });
    const b = await createTestApp({ scope: 'child', bootstrap: false, config: config('audit_b') });
    // A plain child, as the one authn boots AuthnAudit in: no Configuration of its own, it reads its parent's.
    const inner = a.container.child();
    try {
      expect(audit(a.container)).to.eq(audit(a.container));
      expect(audit(a.container)).to.not.eq(audit(b.container));
      expect(audit(inner)).to.not.eq(audit(a.container));

      for (const service of [audit(a.container), audit(b.container), audit(inner)]) await service.record({ kind: 'security', action: 'login' }, { trail: 'own' });
      expect(MemoryAuditStore.appends().map((write) => write.trail.table)).to.deep.eq(['audit_a', 'audit_b', 'audit_a']);
      expect(MemoryAuditStore.events('own')).to.have.length(3);
      expect(() => trailConfig('own')).to.throw(AuditConfigError, 'audit: no trail named "own"');
    } finally {
      await inner.dispose();
      await a.dispose();
      await b.dispose();
    }
  });
});

describe('TestAuditContext', function () {
  this.timeout(15000);

  it('stamps what a test set, and its defaults after reset()', async () => {
    MemoryAuditStore.reset();
    const config = { logger: SILENT, audit: { trails: { default: { store: 'MemoryAuditStore' } } } };
    const app = await createTestApp({ config, register: (container) => container.register(TestAuditContext).as(AuditContext) });
    try {
      Object.assign(TestAuditContext.who, { actor: 'user:u7', onBehalfOf: 'user:admin', traceId: TRACE, origin: '10.0.0.9' });
      await audit().record({ kind: 'action', action: 'a' }, { mode: 'confirmed' });
      TestAuditContext.reset();
      await audit().record({ kind: 'action', action: 'b' }, { mode: 'confirmed' });
      expect(MemoryAuditStore.events().map((e) => [e.actor, e.onBehalfOf, e.traceId, e.origin])).to.deep.eq([
        ['user:u7', 'user:admin', TRACE, '10.0.0.9'],
        ['system:test', undefined, undefined, undefined],
      ]);
    } finally {
      await app.dispose();
    }
  });
});
