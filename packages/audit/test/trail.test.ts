import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { AuditConfigError, AuditNotSupported, AuditStore, audit } from '../src/index.js';
import type { AuditPinnedHead, AuditReader, AuditVerifyReport, TrailConfig } from '../src/index.js';
import { MemoryAuditReader, MemoryAuditStore } from '../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const patient = { type: 'patient', id: '17' };

// Stands in for a reader that can verify, which arrives with the seals of the integrity branches.
class VerifyingReader extends MemoryAuditReader {
  verify(trail: TrailConfig, source?: string, pinned?: AuditPinnedHead): Promise<AuditVerifyReport> {
    return Promise.resolve({ trail: trail.name, connection: source ?? trail.connection, table: trail.table, seals: 0, intact: 0, redacted: 0, prunedSeals: 0, tampered: undefined, unsealed: 0, head: pinned, uncovered: [], unexplainedRedactions: [] });
  }
}

class VerifyingStore extends MemoryAuditStore {
  override reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(new VerifyingReader());
  }
}

const TRAILS = {
  default: { store: 'MemoryAuditStore' },
  sealed: { store: 'VerifyingStore', integrity: 'sealed' },
  unverifiable: { store: 'MemoryAuditStore', integrity: 'sealed' },
  logged: { store: 'LogAuditStore', integrity: 'sealed' },
};

describe('audit().trail', function () {
  this.timeout(15000);
  let app: TestApp;

  const as = (id: string, traceId: string | undefined, fn: () => Promise<void>): Promise<void> => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).run({ Principal: { type: 'user', id }, traceId }, fn);

  beforeEach(async () => {
    MemoryAuditStore.reset();
    app = await createTestApp({ config: { logger: SILENT, audit: { trails: TRAILS } }, register: (container) => container.register(VerifyingStore).as(AuditStore) });
    await as('u1', TRACE, () =>
      audit().record(
        [
          { kind: 'read', action: 'patient.read', subject: patient },
          { kind: 'action', action: 'report.export' },
        ],
        { mode: 'confirmed' },
      ),
    );
    await as('u2', undefined, () => audit().record({ kind: 'data', action: 'update', subject: patient, data: { changed: ['ward'] } }, { mode: 'confirmed' }));
  });

  afterEach(async () => {
    await app.dispose();
  });

  it('answers who did what, to what, in which request', async () => {
    const trail = audit().trail();
    expect(trail.config.name).to.eq('default');
    expect((await trail.byActor('user:u1')).map((e) => e.action)).to.deep.eq(['patient.read', 'report.export']);
    expect((await trail.of(patient)).map((e) => e.actor)).to.deep.eq(['user:u1', 'user:u2']);
    expect((await trail.of(patient, { kinds: ['data'] })).map((e) => e.action)).to.deep.eq(['update']);
    expect((await trail.byTrace(TRACE)).map((e) => e.seq)).to.deep.eq([1, 2]);
  });

  it('pages by seq and checks the limit and the trace id', async () => {
    const trail = audit().trail();
    const first = await trail.since(0, { limit: 2 });
    expect(first.map((e) => e.seq)).to.deep.eq([1, 2]);
    expect((await trail.since(first[1].seq)).map((e) => e.seq)).to.deep.eq([3]);
    await expect(trail.since(0, { limit: 0 })).to.be.rejectedWith(AuditConfigError, 'audit: limit must be an integer from 1 to 1000');
    await expect(trail.byTrace('nope')).to.be.rejectedWith(AuditConfigError, 'audit: "nope" is not a trace id');
  });

  it('reads newest first on request and narrows any read to one subject type', async () => {
    const trail = audit().trail();
    expect((await trail.of(patient, { order: 'desc' })).map((e) => e.actor)).to.deep.eq(['user:u2', 'user:u1']);
    expect((await trail.byActor('user:u1', { order: 'desc', limit: 1 })).map((e) => e.action)).to.deep.eq(['report.export']);
    expect((await trail.since(0, { subjectType: 'patient' })).map((e) => e.seq)).to.deep.eq([1, 3]);
    expect((await trail.since(1, { subjectType: 'patient', order: 'desc' })).map((e) => e.seq)).to.deep.eq([3]);
    expect(await trail.since(0, { subjectType: 'invoice' })).to.deep.eq([]);
  });

  it('verifies through the reader, and refuses a trail that is not sealed or cannot be verified here', async () => {
    expect(await audit().trail('sealed').verify('orders')).to.include({ trail: 'sealed', connection: 'orders', table: 'audit_event', tampered: undefined });
    expect((await audit().trail('sealed').verify(undefined, { toSeq: 7, hash: 'h' })).head).to.deep.eq({ toSeq: 7, hash: 'h' });
    await expect(audit().trail().verify()).to.be.rejectedWith(AuditNotSupported, 'audit: trail "default" is not sealed, so it has nothing to verify (audit.trails.default.integrity)');
    await expect(audit().trail('unverifiable').verify()).to.be.rejectedWith(AuditNotSupported, 'audit: the reader MemoryAuditReader of trail "unverifiable" cannot verify seals');
    await expect(audit().trail('logged').verify()).to.be.rejectedWith(AuditNotSupported, 'audit: trail "logged" (store LogAuditStore) cannot be read from this application (verify)');
  });

  it('forgets a subject and records the erasure, on the source it was asked to redact', async () => {
    const trail = audit().trail();
    expect(await trail.forget(patient)).to.eq(2);
    expect((await trail.of(patient)).map((e) => [e.action, e.redacted, e.data])).to.deep.eq([
      ['patient.read', true, {}],
      ['update', true, {}],
      ['erasure', false, { redacted: 2 }],
    ]);

    expect(await trail.forget({ type: 'patient', id: '99' }, 'orders')).to.eq(0);
    // The two appends of beforeEach, then one erasure without a source and one with.
    expect(MemoryAuditStore.appends().map((write) => write.connection)).to.deep.eq([undefined, undefined, undefined, 'orders']);
  });

  it('refuses a trail whose store has no reader, and an unknown trail', async () => {
    await expect(audit().trail('security').byActor('user:u1')).to.be.rejectedWith(AuditNotSupported, 'audit: trail "security" (store LogAuditStore) cannot be read from this application (byActor)');
    expect(() => audit().trail('nope')).to.throw(AuditConfigError, 'audit: no trail named "nope"');
  });
});
