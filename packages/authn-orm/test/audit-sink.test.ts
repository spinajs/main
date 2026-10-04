import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent, IdentityRef } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { DbAuthnAuditSink, fromUtcColumn } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const T0 = new Date('2026-06-01T10:00:00.123Z');
const ALICE: IdentityRef = { type: 'user', id: '0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10' };
const ADMIN: IdentityRef = { type: 'user', id: '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface AuditRow {
  id: string;
  at_text: string;
  type: string;
  outcome: string;
  identity: string | null;
  actor: string | null;
  strategy: string | null;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  session: string | null;
  data: string | null;
}

async function auditRows(db: TestDb): Promise<AuditRow[]> {
  return (await rawQuery(db.driver, 'SELECT id, CAST(at AS TEXT) AS at_text, type, outcome, identity, actor, strategy, reason, ip, user_agent, session, data FROM authn_audit ORDER BY at, type')) as AuditRow[];
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('DbAuthnAuditSink registration', () => {
  it('is registered as an AuthnEventSink under its class name', () => {
    expect(DbAuthnAuditSink.name).to.eq('DbAuthnAuditSink');
    expect(DI.RootContainer.hasRegistered('DbAuthnAuditSink')).to.eq(true);
    expect(DI.RootContainer.getRegisteredTypes(AuthnEventSink)).to.include(DbAuthnAuditSink);
  });

  it('resolves through the AuthnEventSink list of a container where it is registered', async () => {
    const container = DI.child();
    container.register(DbAuthnAuditSink).as(AuthnEventSink);

    const sinks = await container.resolve(Array.ofType(AuthnEventSink));

    expect(sinks.length).to.be.greaterThan(0);
    for (const sink of sinks) {
      expect(sink).to.be.instanceOf(DbAuthnAuditSink);
    }
  });
});

for (const kind of DB_KINDS) {
  describe(`DbAuthnAuditSink (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let sink: DbAuthnAuditSink;

    before(async function () {
      db = await bootDb(this, kind, 'audit');
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authn_audit', [], QueryContext.Delete);
      sink = new DbAuthnAuditSink(db.driver);
    });

    it('SR-11 the DB sink keeps login and impersonation rows', async () => {
      const login: AuthnEvent = { type: 'login', at: T0, outcome: 'success', identity: ALICE, strategy: 'local', ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (kit)', session: 'h'.repeat(43) };
      const start: AuthnEvent = { type: 'impersonation.start', at: new Date(T0.getTime() + 1500), outcome: 'success', actor: ADMIN, identity: ALICE, ip: '198.51.100.4', data: { target: ALICE } };

      await sink.publish(login);
      await sink.publish(start);

      const rows = await auditRows(db);
      expect(rows).to.have.length(2);
      const [l, s] = rows;
      expect(l.id).to.match(UUID_V4);
      expect(s.id).to.match(UUID_V4);
      expect([l.type, l.outcome, l.identity, l.actor, l.ip, l.user_agent, l.strategy, l.session]).to.deep.eq(['login', 'success', `user:${ALICE.id}`, null, '203.0.113.9', 'Mozilla/5.0 (kit)', 'local', 'h'.repeat(43)]);
      expect([s.type, s.outcome, s.identity, s.actor, s.ip]).to.deep.eq(['impersonation.start', 'success', `user:${ALICE.id}`, `user:${ADMIN.id}`, '198.51.100.4']);
      expect(fromUtcColumn(l.at_text)).to.deep.eq(login.at);
      expect(fromUtcColumn(s.at_text)).to.deep.eq(start.at);
    });

    it('cuts over-long free text to the column width instead of refusing the event', async () => {
      const userAgent = 'U'.repeat(254) + '\u{1F600}' + 'tail';
      await sink.publish({ type: 'login', at: T0, outcome: 'failure', reason: 'r'.repeat(80), strategy: 's'.repeat(70), ip: '1'.repeat(65), session: 'x'.repeat(100), userAgent });

      const [row] = await auditRows(db);
      expect(row.user_agent).to.eq('U'.repeat(254) + '\u{1F600}');
      expect([...row.user_agent!]).to.have.length(255);
      expect(row.reason).to.eq('r'.repeat(64));
      expect(row.strategy).to.eq('s'.repeat(64));
      expect(row.ip).to.eq('1'.repeat(64));
      expect(row.session).to.eq('x'.repeat(64));
    });

    it('stores data as JSON that round-trips, and null without data', async () => {
      const data = { provider: 'oidc:g', steps: ['totp'], nested: { n: 1, ok: true, none: null } };
      await sink.publish({ type: 'identity.link', at: T0, outcome: 'success', identity: ALICE, data });
      await sink.publish({ type: 'logout', at: new Date(T0.getTime() + 1), outcome: 'success', identity: ALICE });

      const [withData, without] = await auditRows(db);
      expect(JSON.parse(withData.data!)).to.deep.eq(data);
      expect(without.data).to.eq(null);
    });

    it('never cuts an identity or actor key: one that does not fit goes whole into data, the column stays null', async () => {
      const long = { type: 'user', id: 'x'.repeat(96) };
      const odd = { type: 'a:b', id: 'svc' };
      await sink.publish({ type: 'key.register', at: T0, outcome: 'success', identity: long, actor: odd as IdentityRef, data: { kid: 'k1' } });
      const [row] = await auditRows(db);
      expect(row.identity).to.eq(null);
      expect(row.actor).to.eq(null);
      expect(JSON.parse(row.data!)).to.deep.eq({ kid: 'k1', identityRef: long, actorRef: odd });
    });

    it('stores data that JSON cannot express without failing the event', async () => {
      const cyclic: Record<string, unknown> = { n: 1 };
      cyclic.self = cyclic;
      await sink.publish({ type: 'login', at: T0, outcome: 'success', identity: ALICE, data: { big: 10n } });
      await sink.publish({ type: 'logout', at: T0, outcome: 'success', identity: ALICE, data: cyclic });
      const [login, logout] = await auditRows(db);
      expect(JSON.parse(login.data!)).to.deep.eq({ big: '10' });
      expect(JSON.parse(logout.data!)).to.deep.eq({ unserialisable: true });
    });

    it('refuses an event without a valid time', async () => {
      expect(await rejection(sink.publish({ type: 'login', at: new Date(NaN), outcome: 'success' }))).to.be.instanceOf(InvalidArgument);
      expect(await auditRows(db)).to.deep.eq([]);
    });

    it("resolves the Orm's default connection from its container when given no driver", async () => {
      await new DbAuthnAuditSink(undefined, { container: db.container }).publish({ type: 'logout', at: T0, outcome: 'success' });
      expect(await auditRows(db)).to.have.length(1);
    });
  });
}
