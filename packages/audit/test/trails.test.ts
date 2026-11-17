import * as chai from 'chai';
import 'mocha';
import '@spinajs/log';
import { createTestApp } from '@spinajs/testing';
import { AuditConfigError, SECURITY_HASH_PATHS, deferredConfig, trailConfig, trailNames } from '../src/index.js';

const expect = chai.expect;
const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

describe('trailConfig', function () {
  this.timeout(15000);

  it('answers the three built-in trails when nothing is configured', () => {
    expect(trailConfig()).to.include({ name: 'default', store: 'TableAuditStore', table: 'audit_event', connection: 'default', onFailure: 'continue', integrity: 'none', retentionDays: undefined, sink: undefined, reader: undefined, archiveConnection: undefined });
    expect(trailConfig().retry).to.deep.eq({ attempts: 3, delayMs: 100 });
    expect([trailConfig().omit, trailConfig().mask, trailConfig().hash]).to.deep.eq([[], [], []]);
    expect(trailConfig('history')).to.include({ store: 'TableAuditStore', table: 'orm_history' });
    expect(trailConfig('security')).to.include({ store: 'LogAuditStore' });
    expect(trailConfig('security').hash).to.deep.eq(SECURITY_HASH_PATHS);
    expect(trailNames()).to.deep.eq(['default', 'history', 'security']);
    expect(deferredConfig()).to.deep.eq({ flushMs: 1000, maxBatch: 500, maxBuffered: 10000, timeoutMs: 2000 });
  });

  it('refuses an unknown trail', () => {
    expect(() => trailConfig('nope')).to.throw(AuditConfigError, 'audit: no trail named "nope" (configured: default, history, security)');
    expect(() => trailConfig('__proto__')).to.throw(AuditConfigError, 'audit: no trail named "__proto__"');
  });

  it('lays a configured trail over the built-in of its name and parses the retry delay', async () => {
    const restricted = { table: 'audit_restricted', onFailure: 'reject', retry: { attempts: 5, delay: '2s' }, integrity: 'sealed', mask: ['data.args.password'], sink: 'ArchiveAuditSink', archiveConnection: 'audit' };
    const app = await createTestApp({ config: { logger: SILENT, audit: { deferred: { flushMs: 5 }, trails: { history: { retentionDays: 30, retry: { delay: 250 } }, restricted } } } });
    try {
      expect(trailConfig('history')).to.include({ table: 'orm_history', retentionDays: 30 });
      expect(trailConfig('history').retry).to.deep.eq({ attempts: 3, delayMs: 250 });
      expect(trailConfig('restricted')).to.include({ store: 'TableAuditStore', table: 'audit_restricted', connection: 'default', onFailure: 'reject', integrity: 'sealed', sink: 'ArchiveAuditSink', archiveConnection: 'audit' });
      expect(trailConfig('restricted').retry).to.deep.eq({ attempts: 5, delayMs: 2000 });
      expect(trailConfig('restricted').mask).to.deep.eq(['data.args.password']);
      expect(trailNames()).to.deep.eq(['default', 'history', 'security', 'restricted']);
      expect(deferredConfig().flushMs).to.eq(5);
    } finally {
      await app.dispose();
    }
  });

  it('refuses a path that would break the event, and a delay it cannot read', async () => {
    const app = await createTestApp({ config: { logger: SILENT, audit: { trails: { bad: { omit: ['actor'] }, worse: { mask: ['kind'] }, slow: { retry: { delay: 'soon' } } } } } });
    try {
      expect(() => trailConfig('bad')).to.throw(AuditConfigError, 'audit: trail "bad": omit path "actor" is not maskable; use data.<path>, or actor, onBehalfOf, origin or dataSubject (actor cannot be omitted)');
      expect(() => trailConfig('worse')).to.throw(AuditConfigError, 'audit: trail "worse": mask path "kind" is not maskable');
      expect(() => trailConfig('slow')).to.throw(AuditConfigError, 'audit: trail "slow": retry.delay must be milliseconds or a duration like "100ms", "2s" or "1m"');
    } finally {
      await app.dispose();
    }
  });

  it('leaves the sections other packages keep under audit alone, and drops a trail key it does not know', async () => {
    const others = { http: { rules: [{ match: 'DELETE /admin/**', action: 'admin.delete' }] }, data: { rules: [{ models: '*', trail: 'history' }] }, authn: { trail: 'security' }, queue: { maxMessageBytes: 200000 }, seal: { settleSeconds: 30 } };
    // What a package that owns a section registers: its own schema, under the audit root.
    const ship = { $id: 'test/audit.ship.schema.json', $configurationModule: 'audit.ship', type: 'object', properties: { batchSize: { type: 'integer', minimum: 1 }, maxBatches: { type: 'integer', default: 50 } } };
    const shipped = { store: 'OutboxAuditStore', archiveConnection: 'audit', archiveConection: 'misspelt' };
    const app = await createTestApp({ config: { logger: SILENT, audit: { ...others, ship: { batchSize: 200 }, trails: { shipped } } }, schemas: [ship] });
    try {
      const read = (name: string): unknown => app.config.get<unknown>(['audit', name]);
      expect([read('http'), read('data'), read('authn'), read('queue'), read('seal')]).to.deep.eq([others.http, others.data, others.authn, others.queue, others.seal]);
      expect(read('ship')).to.deep.eq({ batchSize: 200, maxBatches: 50 });
      expect(trailConfig('shipped')).to.include({ store: 'OutboxAuditStore', archiveConnection: 'audit' });
      expect(app.config.get<unknown>(['audit', 'trails', 'shipped'])).to.deep.eq({ store: 'OutboxAuditStore', archiveConnection: 'audit' });
    } finally {
      await app.dispose();
    }
  });

  it('reads the configuration of the container it is given, and the built-in trails when there is none', async () => {
    const app = await createTestApp({ scope: 'child', bootstrap: false, config: { logger: SILENT, audit: { trails: { child: { table: 'audit_child' } } } } });
    try {
      expect(trailConfig('child', app.container)).to.include({ name: 'child', table: 'audit_child' });
      expect(trailConfig('child', app.container.child()).table).to.eq('audit_child');
      expect(trailNames(app.container)).to.deep.eq(['default', 'history', 'security', 'child']);
      // The root container has no Configuration here.
      expect(trailNames()).to.deep.eq(['default', 'history', 'security']);
      expect(trailConfig('security').store).to.eq('LogAuditStore');
      expect(() => trailConfig('child')).to.throw(AuditConfigError, 'audit: no trail named "child"');
    } finally {
      await app.dispose();
    }
  });
});
