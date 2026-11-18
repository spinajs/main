import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { AuditConfigError, AuditContext, AuditStore, AuditWriteFailed, audit, trailConfig } from '../src/index.js';
import type { AuditAppend, AuditInput } from '../src/index.js';
import { MemoryAuditStore, TestAuditContext } from '../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
const TRACE = '0af7651916cd43dd8448eb211c80319c';

// Stands in for a context of the caller's own, such as a driver's transaction storage.
const callers = new AsyncLocalStorage<string>();

class ProbeStore extends MemoryAuditStore {
  static seen: (string | undefined)[] = [];
  static asked = 0;
  override append(write: AuditAppend): Promise<void> {
    ProbeStore.seen.push(callers.getStore());
    return super.append(write);
  }
  override joinsCaller(): boolean {
    ProbeStore.asked += 1;
    return super.joinsCaller();
  }
}

// How a suite of another package makes the memory store fail on demand and counts the tries.
class FlakyStore extends MemoryAuditStore {
  static calls = 0;
  static down = false;
  static failure: unknown = new Error('store down');
  override async append(write: AuditAppend): Promise<void> {
    FlakyStore.calls += 1;
    if (FlakyStore.down) throw FlakyStore.failure;
    await super.append(write);
  }
}

// Holds the next `holds` appends until the test settles them.
class SlowStore extends MemoryAuditStore {
  static calls = 0;
  static holds = 0;
  static readonly held: { release: () => void; fail: () => void }[] = [];
  override append(write: AuditAppend): Promise<void> {
    SlowStore.calls += 1;
    if (SlowStore.holds === 0) return super.append(write);
    SlowStore.holds -= 1;
    return new Promise<void>((resolve, reject) => {
      SlowStore.held.push({ release: () => resolve(super.append(write)), fail: () => reject(new Error('store gave up')) });
    });
  }
}

class AskFailsStore extends MemoryAuditStore {
  static failure: unknown = new Error('cannot tell');
  override joinsCaller(): boolean {
    throw AskFailsStore.failure;
  }
}

class MisconfiguredStore extends MemoryAuditStore {
  static calls = 0;
  override append(): Promise<void> {
    MisconfiguredStore.calls += 1;
    return Promise.reject(new AuditConfigError('audit: no ORM connection "nope"'));
  }
}

const TRAILS = {
  default: { store: 'MemoryAuditStore' },
  strict: { store: 'MemoryAuditStore', onFailure: 'reject', retry: { attempts: 3, delay: 1 }, mask: ['data.args.password'] },
  twice: { store: 'FlakyStore', onFailure: 'reject', retry: { attempts: 2, delay: '1ms' } },
  flaky: { store: 'FlakyStore', retry: { attempts: 2, delay: 1 } },
  sleepy: { store: 'FlakyStore', retry: { attempts: 3, delay: '1s' } },
  sleepyStrict: { store: 'FlakyStore', onFailure: 'reject', retry: { attempts: 3, delay: '1s' } },
  slow: { store: 'SlowStore', retry: { attempts: 3, delay: 1 } },
  slowStrict: { store: 'SlowStore', onFailure: 'reject', retry: { attempts: 3, delay: 1 } },
  misconfigured: { store: 'MisconfiguredStore', retry: { attempts: 3, delay: 1 } },
  misconfiguredStrict: { store: 'MisconfiguredStore', onFailure: 'reject', retry: { attempts: 3, delay: 1 } },
  probe: { store: 'ProbeStore' },
  askFails: { store: 'AskFailsStore' },
  askFailsToo: { store: 'AskFailsStore' },
  orphan: { store: 'NoSuchStore' },
};

type Line = { level: string; fields: Record<string, unknown>; message: string };

// Answers every Log resolved from now on, the service's "audit-pipeline" logger included: records the lines, or, broken, records each resolution and throws as an app without @spinajs/log would.
function pipelineLog(container: IContainer, broken = false): Line[] {
  const lines: Line[] = [];
  const logger = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map((level) => [level, (fields: Record<string, unknown>, message: string) => lines.push({ level, fields, message })]));
  const factory = (): typeof logger => {
    if (broken) {
      lines.push({ level: 'resolve', fields: {}, message: '' });
      throw new Error('no logger');
    }
    return logger;
  };
  container.register(factory).as(Log);
  return lines;
}

const boot = (deferred: Record<string, unknown> = {}, audit: Record<string, unknown> = {}): Promise<TestApp> =>
  createTestApp({
    config: { logger: SILENT, audit: { deferred: { flushMs: 20, ...deferred }, trails: TRAILS, ...audit } },
    register: (container) => {
      for (const store of [ProbeStore, FlakyStore, SlowStore, MisconfiguredStore, AskFailsStore]) container.register(store).as(AuditStore);
    },
  });

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const actions = (...names: string[]): AuditInput[] => names.map((action) => ({ kind: 'action', action }));
const patientOf = (id: string) => ({ type: 'patient', id });

describe('audit().record', function () {
  this.timeout(15000);
  let app: TestApp;

  beforeEach(async () => {
    MemoryAuditStore.reset();
    ProbeStore.seen = [];
    ProbeStore.asked = 0;
    FlakyStore.calls = 0;
    FlakyStore.down = false;
    app = await boot();
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

  it('cuts what the context supplies to its column width', async () => {
    const request = { Principal: { type: 'user', id: 'u'.repeat(200) }, realIp: '1'.repeat(100) };
    await (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).run(request, () => audit().record(actions('wide'), { mode: 'confirmed' }));
    const [event] = MemoryAuditStore.events();
    expect([event.actor, event.origin]).to.deep.eq([`user:${'u'.repeat(95)}`, '1'.repeat(64)]);
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

  it('flush() on an empty buffer settles on microtasks alone', async () => {
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

  it('carries on when a continue trail cannot record, and logs the event ids', async () => {
    const lines = pipelineLog(app.container);
    MemoryAuditStore.failNext(3);
    await audit().record({ kind: 'action', action: 'x' }, { mode: 'confirmed' });
    expect(MemoryAuditStore.events()).to.have.length(0);
    expect(lines.map((l) => [l.level, l.fields.trail, l.fields.count])).to.deep.eq([['error', 'default', 1]]);
    expect(lines[0].fields.ids).to.match(/^[0-9a-f-]{36}$/);
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

  it('passes an audit error the store raises in a transactional write through unchanged', async () => {
    FlakyStore.down = true;
    try {
      for (const failure of [new AuditWriteFailed('audit: the store gave up'), new AuditConfigError('audit: no ORM connection "nope"')]) {
        FlakyStore.failure = failure;
        const raised: unknown = await audit()
          .record({ kind: 'data', action: 'update' }, { trail: 'flaky', mode: 'transactional', transaction: {} })
          .catch((e: unknown) => e);
        expect(raised).to.eq(failure);
      }
      expect(FlakyStore.calls).to.eq(2);
    } finally {
      FlakyStore.failure = new Error('store down');
    }
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

  it("keeps confirmed and deferred writes out of the caller's async context, unless the store joins the caller", async () => {
    const run = (): Promise<void> =>
      callers.run('caller', async () => {
        await audit().record({ kind: 'action', action: 'a' }, { trail: 'probe', mode: 'confirmed' });
        await audit().record({ kind: 'action', action: 'b' }, { trail: 'probe' });
        await audit().flush();
        await audit().record({ kind: 'data', action: 'insert' }, { trail: 'probe', mode: 'transactional', transaction: {} });
      });
    await run();
    MemoryAuditStore.joinCaller(true);
    await run();
    expect(ProbeStore.seen).to.deep.eq([undefined, undefined, 'caller', 'caller', undefined, 'caller']);
    // Asked once per confirmed write, never for a deferred or a transactional one.
    expect(ProbeStore.asked).to.eq(2);
  });

  it('tries a write that joins the caller once: a reject trail rejects, a continue trail logs the loss', async () => {
    const lines = pipelineLog(app.container);
    MemoryAuditStore.joinCaller(true);
    FlakyStore.down = true;
    await expect(audit().record(actions('a'), { trail: 'twice' })).to.be.rejectedWith(AuditWriteFailed, 'audit: trail "twice" could not record 1 event(s) after 1 attempt(s)');
    await audit().record(actions('b'), { trail: 'flaky', mode: 'confirmed' });
    expect(FlakyStore.calls).to.eq(2);
    expect(lines.map((l) => [l.level, l.fields.trail, l.message])).to.deep.eq([['error', 'flaky', 'audit: trail ${trail} lost ${count} event(s): ${ids}']]);
  });

  it('writes detached when joinsCaller throws, and says so once per trail; a configuration error it raises fails the write', async () => {
    const lines = pipelineLog(app.container);
    await audit().record(actions('a'), { trail: 'askFails', mode: 'confirmed' });
    await audit().record(actions('b'), { trail: 'askFails', mode: 'confirmed' });
    await audit().record(actions('c'), { trail: 'askFailsToo', mode: 'confirmed' });
    expect(MemoryAuditStore.events().map((e) => e.action)).to.deep.eq(['a', 'b', 'c']);
    const unknown = 'audit: trail ${trail} could not tell whether its store joins the caller; it writes detached';
    expect(lines.map((l) => [l.level, l.fields.trail, l.message])).to.deep.eq([
      ['warn', 'askFails', unknown],
      ['warn', 'askFailsToo', unknown],
    ]);
    AskFailsStore.failure = new AuditConfigError('audit: no ORM connection "nope"');
    await expect(audit().record(actions('d'), { trail: 'askFails', mode: 'confirmed' })).to.be.rejectedWith(AuditConfigError, 'audit: no ORM connection "nope"');
    AskFailsStore.failure = new Error('cannot tell');
  });

  it('refuses a misconfiguration at the call', async () => {
    const input = { kind: 'action', action: 'x' } as const;
    await expect(audit().record(input, { trail: 'nope' })).to.be.rejectedWith(AuditConfigError, 'audit: no trail named "nope"');
    await expect(audit().record(input, { trail: 'orphan' })).to.be.rejectedWith(AuditConfigError, 'audit: trail "orphan" names the store "NoSuchStore", and no AuditStore is registered under that name');
    await expect(audit().record(input, { trail: 'history' })).to.be.rejectedWith(AuditConfigError, "); TableAuditStore is registered by @spinajs/audit-orm: install and import it, or set the trail's store to LogAuditStore");
    await expect(audit().record(input, { trail: 'strict', mode: 'deferred' })).to.be.rejectedWith(AuditConfigError, "audit: a deferred write cannot reject, and trail \"strict\" is written with onFailure 'reject'; use mode 'confirmed'");
    await expect(audit().record({ kind: 'action', action: '' })).to.be.rejectedWith(AuditConfigError, 'audit: action must be 1 to 128 characters');
    await expect(audit().record({ kind: 'action', action: 'x', subject: { type: 't', id: 'i'.repeat(256) } })).to.be.rejectedWith(AuditConfigError, 'audit: subject.id must be 1 to 255 characters');
  });

  it('refuses the reserved erasure pair on every write mode, and writes nothing of the call', async () => {
    const reserved = { kind: 'custom', action: 'erasure', subject: patientOf('9'), data: { email: 'a@b.c' } } as const;
    const REFUSED = "audit: kind 'custom' with action 'erasure' is reserved for the record AuditTrail.forget writes; record this event under another action";
    for (const options of [{ mode: 'transactional', transaction: {} }, { mode: 'confirmed' }, { mode: 'deferred' }, {}] as const) {
      await expect(audit().record(reserved, options)).to.be.rejectedWith(AuditConfigError, REFUSED);
      await expect(audit().record([{ kind: 'action', action: 'kept' }, reserved], options)).to.be.rejectedWith(AuditConfigError, REFUSED);
      // MySQL's PAD SPACE and MSSQL compare 'erasure ' equal to the pair.
      await expect(audit().record({ ...reserved, action: 'erasure  ' }, options)).to.be.rejectedWith(AuditConfigError, REFUSED);
    }
    await audit().flush();
    expect(MemoryAuditStore.appends()).to.deep.eq([]);

    // Only the pair is reserved.
    await audit().record({ kind: 'action', action: 'erasure', subject: patientOf('9') }, { mode: 'confirmed' });
    await audit().record({ kind: 'custom', action: 'erasure.requested', subject: patientOf('9') }, { mode: 'confirmed' });
    await audit().record({ kind: 'custom', action: ' erasure', subject: patientOf('9') }, { mode: 'confirmed' });
    expect(MemoryAuditStore.events().map((e) => [e.kind, e.action])).to.deep.eq([
      ['action', 'erasure'],
      ['custom', 'erasure.requested'],
      ['custom', ' erasure'],
    ]);
  });

  it('writes out the buffer when the service is disposed', async () => {
    await audit().record({ kind: 'action', action: 'late' });
    await app.dispose();
    expect(MemoryAuditStore.events().map((e) => e.action)).to.deep.eq(['late']);
  });
});

describe('audit(): confirmed deadline', function () {
  this.timeout(15000);
  let app: TestApp;

  beforeEach(() => {
    MemoryAuditStore.reset();
    SlowStore.calls = 0;
    SlowStore.held.length = 0;
  });

  afterEach(async () => {
    await app.dispose();
  });

  it('fails a confirmed write that misses confirmTimeoutMs, and logs it when it lands later', async () => {
    app = await boot({}, { confirmTimeoutMs: 50 });
    const lines = pipelineLog(app.container);
    SlowStore.holds = 2;
    const failed: unknown = await audit()
      .record(actions('a'), { trail: 'slowStrict' })
      .catch((e: unknown) => e);
    expect(failed instanceof AuditWriteFailed && failed.inner instanceof Error ? [failed.message, failed.inner.message] : []).to.deep.eq(['audit: trail "slowStrict" could not record 1 event(s) after 1 attempt(s)', 'audit: a confirmed write did not finish within 50 ms']);
    await audit().record(actions('b'), { trail: 'slow', mode: 'confirmed' });
    expect(lines.map((l) => [l.level, l.fields.trail, l.message.includes('not confirmed in time')])).to.deep.eq([['error', 'slow', true]]);

    for (const held of SlowStore.held) held.release();
    await pause(20);
    // The caller of a reject trail was told the write failed: its late landing is an error.
    const stored = 'audit: trail ${trail} stored ${count} event(s) it had given up on: ${ids}';
    expect(lines.slice(1).map((l) => [l.level, l.fields.trail, l.fields.mode, l.fields.onFailure, l.message])).to.deep.eq([
      ['error', 'slowStrict', 'confirmed', 'reject', stored],
      ['warn', 'slow', 'confirmed', 'continue', stored],
    ]);
    expect(SlowStore.calls).to.eq(2);
  });

  it('gives a confirmed write 10000 ms without audit.confirmTimeoutMs', async () => {
    app = await boot();
    const delays: unknown[] = [];
    const setTimer = globalThis.setTimeout;
    const spy = (...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
      delays.push(args[1]);
      return setTimer(...args);
    };
    try {
      Reflect.set(globalThis, 'setTimeout', spy);
      await audit().record(actions('a'), { mode: 'confirmed' });
    } finally {
      Reflect.set(globalThis, 'setTimeout', setTimer);
    }
    expect(delays).to.include(10000);
  });

  it('logs a confirmed write whose deadline fires between two tries as lost, after the tries it made', async () => {
    app = await boot({}, { confirmTimeoutMs: 50 });
    const lines = pipelineLog(app.container);
    FlakyStore.calls = 0;
    FlakyStore.down = true;
    try {
      const failed: unknown = await audit()
        .record(actions('a'), { trail: 'sleepyStrict' })
        .catch((e: unknown) => e);
      expect(failed instanceof AuditWriteFailed && failed.inner instanceof Error ? [failed.message, failed.inner.message] : []).to.deep.eq(['audit: trail "sleepyStrict" could not record 1 event(s) after 1 attempt(s)', 'audit: a confirmed write did not finish within 50 ms']);
      await audit().record(actions('b'), { trail: 'sleepy', mode: 'confirmed' });
      expect(lines.map((l) => [l.level, l.fields.trail, l.message])).to.deep.eq([['error', 'sleepy', 'audit: trail ${trail} lost ${count} event(s): ${ids}']]);
      expect(FlakyStore.calls).to.eq(2);
    } finally {
      FlakyStore.down = false;
    }
  });

  it('gives a write that joins the caller no deadline: it settles with the caller', async () => {
    app = await boot({}, { confirmTimeoutMs: 50 });
    const lines = pipelineLog(app.container);
    MemoryAuditStore.joinCaller(true);
    SlowStore.holds = 1;
    let settled = false;
    const write = audit()
      .record(actions('a'), { trail: 'slowStrict' })
      .finally(() => (settled = true));
    await pause(100);
    expect(settled).to.eq(false);
    SlowStore.held[0].release();
    await write;
    expect(MemoryAuditStore.events().map((e) => e.action)).to.deep.eq(['a']);
    expect(lines).to.deep.eq([]);
  });
});

describe('audit(): deferred batches and failure paths', function () {
  this.timeout(15000);
  let app: TestApp | undefined;

  beforeEach(() => {
    MemoryAuditStore.reset();
    FlakyStore.calls = 0;
    FlakyStore.down = false;
    SlowStore.calls = 0;
    SlowStore.holds = 0;
    SlowStore.held.length = 0;
    MisconfiguredStore.calls = 0;
  });

  afterEach(async () => {
    await app?.dispose();
    app = undefined;
  });

  it('gives a batch up after timeoutMs, and nothing retries it later, not even after dispose', async () => {
    app = await boot({ timeoutMs: 50 });
    const lines = pipelineLog(app.container);
    SlowStore.holds = 1;
    await audit().record(actions('a'), { trail: 'slow' });
    await app.dispose();
    app = undefined;
    SlowStore.held[0].fail();
    await pause(50);
    expect(SlowStore.calls).to.eq(1);
    expect(lines.map((l) => [l.level, l.fields.count])).to.deep.eq([
      ['error', 1],
      ['error', 1],
    ]);
    expect(lines[0].message).to.contain('not confirmed in time');
    expect(lines[1].message).to.eq('audit: trail ${trail} could not store ${count} event(s) it had given up on: ${ids}');
  });

  it('keeps the order of a call split at maxBatch when an append it gave up on lands late', async () => {
    app = await boot({ timeoutMs: 1000, maxBatch: 2 });
    const lines = pipelineLog(app.container);
    SlowStore.holds = 1;
    const before = MemoryAuditStore.appends();
    await audit().record(actions('a', 'b', 'c'), { trail: 'slow' });
    await audit().record(actions('d'), { trail: 'slow' });
    const flushed = audit().flush();
    while (lines.length === 0) await pause(5);
    SlowStore.held[0].release();
    await flushed;
    expect(MemoryAuditStore.appends().map((a) => a.events.map((e) => e.action))).to.deep.eq([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(SlowStore.calls).to.eq(2);
    expect(before).to.have.length(0);
  });

  it('drops batches unsent behind an append that does not settle, says so once, and logs the append when it settles', async () => {
    app = await boot({ timeoutMs: 50, maxBatch: 1 });
    const lines = pipelineLog(app.container);
    SlowStore.holds = 1;
    await audit().record(actions('a', 'b', 'c'), { trail: 'slow' });
    await audit().flush();
    expect(SlowStore.calls).to.eq(1);
    expect(lines.map((l) => [l.level, l.message])).to.deep.eq([
      ['error', 'audit: trail ${trail} gave up ${count} event(s) not confirmed in time; an append already under way may still store them: ${ids}'],
      ['warn', 'audit: trail ${trail} is blocked behind an append that has not settled; its deferred events are dropped until it settles or blockCeilingMs has passed'],
      ['error', 'audit: trail ${trail} lost ${count} event(s): ${ids}'],
      ['error', 'audit: trail ${trail} lost ${count} event(s): ${ids}'],
    ]);

    SlowStore.held[0].release();
    await pause(20);
    expect(lines.slice(4).map((l) => [l.level, l.message])).to.deep.eq([['warn', 'audit: trail ${trail} stored ${count} event(s) it had given up on: ${ids}']]);
    await audit().record(actions('d'), { trail: 'slow' });
    await audit().flush();
    expect(MemoryAuditStore.events('slow').map((e) => e.action)).to.deep.eq(['a', 'd']);
  });

  it('drops a batch behind a block at once, without waiting out timeoutMs', async () => {
    app = await boot({ timeoutMs: 1000, maxBatch: 1 });
    const lines = pipelineLog(app.container);
    SlowStore.holds = 1;
    await audit().record(actions('a', 'b', 'c', 'd'), { trail: 'slow' });
    const flushed = audit().flush();
    while (!lines.some((l) => l.message.includes('is blocked behind'))) await pause(5);
    const blockedAt = Date.now();
    await flushed;
    // Two batches behind the block: waiting out timeoutMs each would take 2000 ms.
    expect(Date.now() - blockedAt).to.be.below(500);
    expect(lines.filter((l) => l.message === 'audit: trail ${trail} lost ${count} event(s): ${ids}')).to.have.length(3);
    SlowStore.held[0].release();
    await pause(20);
  });

  it('lifts a block when the held append fails', async () => {
    app = await boot({ timeoutMs: 50, maxBatch: 1 });
    const lines = pipelineLog(app.container);
    SlowStore.holds = 1;
    await audit().record(actions('a', 'b'), { trail: 'slow' });
    await audit().flush();
    SlowStore.held[0].fail();
    await pause(20);
    expect(lines.map((l) => l.level)).to.deep.eq(['error', 'warn', 'error', 'error']);
    expect(lines[3].message).to.eq('audit: trail ${trail} could not store ${count} event(s) it had given up on: ${ids}');
    await audit().record(actions('c'), { trail: 'slow' });
    await audit().flush();
    expect(MemoryAuditStore.events('slow').map((e) => e.action)).to.deep.eq(['c']);
  });

  it('gives up the order of a blocked target after blockCeilingMs, and blocks it again behind a new stuck append', async () => {
    app = await boot({ timeoutMs: 50, blockCeilingMs: 150, maxBatch: 1 });
    const lines = pipelineLog(app.container);
    const write = async (action: string): Promise<void> => {
      await audit().record(actions(action), { trail: 'slow' });
      await audit().flush();
    };
    SlowStore.holds = 1;
    await write('a');
    await write('b');
    await pause(200);
    await write('c');
    expect(MemoryAuditStore.events('slow').map((e) => e.action)).to.deep.eq(['c']);
    const released = lines.filter((l) => l.message.includes('out of order'));
    expect(released.map((l) => [l.level, l.fields.trail])).to.deep.eq([['error', 'slow']]);

    SlowStore.holds = 1;
    await write('d');
    await write('e');
    SlowStore.held[0].release();
    await pause(20);
    expect(lines.filter((l) => l.message.includes('is blocked behind'))).to.have.length(2);
    expect(lines.filter((l) => l.message.includes('stored ${count} event(s) it had given up on'))).to.have.length(1);
    expect(MemoryAuditStore.events('slow').map((e) => e.action)).to.deep.eq(['c', 'a']);
    SlowStore.held[1].release();
  });

  it('measures blockCeilingMs on a monotonic clock, so a wall clock set back does not prolong a block', async () => {
    app = await boot({ timeoutMs: 50, blockCeilingMs: 150, maxBatch: 1 });
    pipelineLog(app.container);
    const write = async (action: string): Promise<void> => {
      await audit().record(actions(action), { trail: 'slow' });
      await audit().flush();
    };
    SlowStore.holds = 1;
    await write('a');
    await write('b');
    const now = Date.now;
    try {
      Date.now = () => 0;
      await pause(200);
      await write('c');
    } finally {
      Date.now = now;
    }
    expect(MemoryAuditStore.events('slow').map((e) => e.action)).to.deep.eq(['c']);
    SlowStore.held[0].release();
    await pause(20);
  });

  it('blocks only the connection whose append is held', async () => {
    app = await boot({ timeoutMs: 50, maxBatch: 1 });
    const lines = pipelineLog(app.container);
    SlowStore.holds = 1;
    await audit().record(actions('a', 'b'), { trail: 'slow', connection: 'x' });
    await audit().record(actions('c'), { trail: 'slow', connection: 'y' });
    await audit().flush();
    expect(MemoryAuditStore.appends().map((a) => [a.connection, a.events.map((e) => e.action)])).to.deep.eq([['y', ['c']]]);
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.fields.connection)).to.deep.eq(['x']);
    SlowStore.held[0].release();
    await pause(20);
  });

  it('logs a failed batch with its event ids and drops it', async () => {
    app = await boot();
    const lines = pipelineLog(app.container);
    FlakyStore.down = true;
    await audit().record(actions('a', 'b'), { trail: 'flaky' });
    await audit().flush();
    expect(lines.map((l) => [l.level, l.fields.trail, l.fields.count])).to.deep.eq([['error', 'flaky', 2]]);
    expect(lines[0].fields.ids).to.match(/^[0-9a-f-]{36},[0-9a-f-]{36}$/);

    FlakyStore.down = false;
    await audit().flush();
    expect(FlakyStore.calls).to.eq(2);
    expect(MemoryAuditStore.events()).to.have.length(0);
  });

  it('drops what does not fit in maxBuffered, with one warning per overflow', async () => {
    app = await boot({ maxBuffered: 2 });
    const lines = pipelineLog(app.container);
    await audit().record(actions('a', 'b', 'c'));
    await audit().record(actions('d'));
    await audit().flush();
    await audit().record(actions('e', 'f', 'g'));
    await audit().flush();
    expect(MemoryAuditStore.events().map((e) => e.action)).to.deep.eq(['a', 'b', 'e', 'f']);
    // The first drop of an overflow is reported at once, the episode's total when the drain makes room again.
    expect(lines.map((l) => [l.level, l.fields.dropped, l.message.startsWith('audit: the deferred buffer is full')])).to.deep.eq([
      ['warn', 1, true],
      ['warn', 2, false],
      ['warn', 1, true],
      ['warn', 1, false],
    ]);
  });

  it('neither retries nor swallows a configuration error the store raises', async () => {
    app = await boot();
    const lines = pipelineLog(app.container);
    const confirmed: unknown = await audit()
      .record(actions('a'), { trail: 'misconfigured', mode: 'confirmed' })
      .catch((e: unknown) => e);
    expect(confirmed).to.be.instanceOf(AuditConfigError).and.to.have.property('message', 'audit: no ORM connection "nope"');
    await expect(audit().record(actions('b'), { trail: 'misconfiguredStrict' })).to.be.rejectedWith(AuditConfigError, 'audit: no ORM connection "nope"');
    expect(MisconfiguredStore.calls).to.eq(2);

    // A deferred write cannot reach its caller: it is tried once, dropped and logged as a misconfiguration.
    await audit().record(actions('c'), { trail: 'misconfigured' });
    await audit().flush();
    expect(MisconfiguredStore.calls).to.eq(3);
    expect(lines.map((l) => [l.level, l.fields.trail, l.message])).to.deep.eq([['error', 'misconfigured', 'audit: trail ${trail} is misconfigured; dropped ${count} event(s): ${ids}']]);
    expect(lines[0].fields.error).to.be.instanceOf(AuditConfigError);
  });

  it('refuses a payload that cannot be written as JSON at the call, and writes a bigint', async () => {
    app = await boot();
    const lines = pipelineLog(app.container);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(audit().record({ kind: 'action', action: 'x', data: circular })).to.be.rejectedWith(AuditConfigError, 'audit: data cannot be written as JSON');

    const sparse: number[] = [];
    sparse[0] = 1;
    sparse[2] = 3;
    await audit().record({ kind: 'security', action: 'login', data: { n: 7n, sparse } }, { trail: 'security' });
    await audit().flush();
    expect(lines.map((l) => [l.level, l.fields.data])).to.deep.eq([['info', '{"n":"7","sparse":[1,null,3]}']]);
    expect(JSON.parse(String(lines[0].fields.data))).to.deep.eq({ n: '7', sparse: [1, null, 3] });
  });

  it('never fails a write or the background flush when the logger cannot be built', async () => {
    app = await boot({ maxBuffered: 1 });
    const resolutions = pipelineLog(app.container, true);
    const unhandled: unknown[] = [];
    const warnings: string[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    const emitWarning: unknown = Reflect.get(process, 'emitWarning');
    Reflect.set(process, 'emitWarning', (warning: string, type: string) => void (type === 'AuditWarning' && warnings.push(warning)));
    process.on('unhandledRejection', onUnhandled);
    try {
      FlakyStore.down = true;
      // Neither the logger's fallback may throw on a failure that JSON cannot hold.
      FlakyStore.failure = { n: 1n };
      await audit().record(actions('a', 'b'), { trail: 'flaky' });
      await audit().record(actions('c'), { trail: 'flaky', mode: 'confirmed' });
      await pause(150);
      expect(unhandled).to.deep.eq([]);
      expect(warnings).to.have.length(4);
      expect(resolutions).to.have.length(1);

      // A store that fails with an Error: the line names it, and neither its stack nor the logger's is printed.
      FlakyStore.failure = new Error('store down');
      await audit().record(actions('d'), { trail: 'flaky', mode: 'confirmed' });
      expect(warnings).to.have.length(5);
      expect(warnings[4]).to.contain('Error: store down');
      for (const warning of warnings) expect(warning).to.contain('Error: no logger').and.not.match(/^\s+at /m);
    } finally {
      FlakyStore.failure = new Error('store down');
      Reflect.set(process, 'emitWarning', emitWarning);
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('writes a deferred event at once when the service is already disposed', async () => {
    app = await boot();
    const service = audit();
    await service.dispose();
    await service.record(actions('late'));
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
