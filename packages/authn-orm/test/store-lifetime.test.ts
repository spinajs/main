import type { AuthnContext, IdentityRef } from '@spinajs/authn/contracts';
import { expect } from 'chai';
import 'mocha';

import { DbAuthnAuditSink, DbAuthnThrottle, DbIdentityLinkStore, DbMfaEnrolments, DbMfaStore, DbNonceStore, DbSecretStore } from '../src/index.js';
import { TestDb, bootDb, rawQuery } from './support/db.js';

const T0 = new Date('2026-06-01T10:00:00.000Z');
const ALICE: IdentityRef = { type: 'user', id: '0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10' };
const CTX: AuthnContext = { now: T0, ip: '192.0.2.10', userAgent: 'authn-orm-test', purpose: 'login' };

async function count(db: TestDb, table: string): Promise<number> {
  const [row] = (await rawQuery(db.driver, `SELECT COUNT(*) AS n FROM ${table}`)) as { n: number | string }[];
  return Number(row.n);
}

describe('authn-orm stores per child container', function () {
  this.timeout(60000);

  let a: TestDb;
  let b: TestDb;

  before(async function () {
    a = await bootDb(this, 'sqlite', 'lifetime-a');
    b = await bootDb(this, 'sqlite', 'lifetime-b');
  });

  after(async () => {
    await a?.dispose();
    await b?.dispose();
  });

  const cases: [string, string, (db: TestDb) => Promise<unknown>][] = [
    ['DbAuthnAuditSink', 'authn_audit', async (db) => (await db.container.resolve(DbAuthnAuditSink)).publish({ type: 'logout', at: T0, outcome: 'success' })],
    ['DbIdentityLinkStore', 'authn_identity', async (db) => (await db.container.resolve(DbIdentityLinkStore)).link(ALICE, { provider: 'p', subject: 's' })],
    ['DbMfaStore', 'authn_mfa', async (db) => (await db.container.resolve(DbMfaStore)).putPending(ALICE, 'totp', 'v1.a.b.c', 'kid')],
    ['DbNonceStore', 'authn_nonce', async (db) => (await db.container.resolve(DbNonceStore)).claim('k', new Date(T0.getTime() + 60_000), T0)],
    ['DbSecretStore', 'authn_secret', async (db) => (await db.container.resolve(DbSecretStore)).issue(ALICE, 'reset', 60)],
    ['DbAuthnThrottle', 'authn_throttle', async (db) => (await db.container.resolve(DbAuthnThrottle)).attempt([{ kind: 'account', value: 'alice@example.test' }], 'login', CTX)],
  ];

  for (const [name, table, write] of cases) {
    it(`${name} resolved in a container writes to that container's Orm`, async () => {
      await write(a);
      expect(await count(a, table)).to.eq(1);
      expect(await count(b, table)).to.eq(0);
    });
  }

  it('gives each container its own instance and keeps it', async () => {
    for (const type of [DbAuthnAuditSink, DbIdentityLinkStore, DbMfaStore, DbNonceStore, DbSecretStore, DbAuthnThrottle, DbMfaEnrolments]) {
      const inA = await a.container.resolve<object>(type);
      expect(inA, type.name).to.not.eq(await b.container.resolve<object>(type));
      expect(inA, type.name).to.eq(await a.container.resolve<object>(type));
    }
  });

  it('DbMfaEnrolments reads the DbMfaStore of its own container', async () => {
    await (await b.container.resolve(DbMfaStore)).putPending(ALICE, 'totp', 'v1.a.b.c', 'kid');
    await (await b.container.resolve(DbMfaStore)).confirm(ALICE, 'totp', T0);
    expect(await (await b.container.resolve(DbMfaEnrolments)).stepsOf(ALICE)).to.deep.eq(['totp']);
    expect(await (await a.container.resolve(DbMfaEnrolments)).stepsOf(ALICE)).to.deep.eq([]);
  });
});
