import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzAdminFailure, AuthzClock, AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { AuthzTx, LinkDef, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { OrmDriver, QueryContext } from '@spinajs/orm';
import { createHash, createHmac, randomBytes } from 'node:crypto';

import { AdminLinkStore, AuthzRbac_2026_10_01_00_00_00, DbAssignmentStore, DbLinkStore, LINK_LIST_MAX_LIMIT, LINK_SECRET_KEY, LINK_TOKEN_MAX_LENGTH, LinkStore, linkTokenHash, readVersion, toDate } from '../../src/index.js';
import { bootDb, DB_KINDS, rawQuery, TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AT = new Date('2026-10-01T12:00:00.000Z');
const BEFORE = new Date(AT.getTime() - 1000);
const AFTER = new Date(AT.getTime() + 3_600_000);
const CREATED = new Date('2026-09-30T08:15:30.250Z');

const SECRET = 'l2-task-7-link-secret-0123456789abcdef';
const OTHER_SECRET = 'l2-task-7-other-secret-0123456789abcdef';

const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const F1: ResourceRef = { type: 'file', id: 'f1' };

const root: PrincipalRef = { type: 'user', id: 'root' };
const alice: PrincipalRef = { type: 'user', id: 'alice' };

class FixedClock extends AuthzClock {
  now(): Date {
    return CREATED;
  }
}

type Row = Record<string, unknown>;

const freshToken = () => randomBytes(32).toString('base64url');

const failure = async (p: Promise<unknown>): Promise<AuthzAdminFailure> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).to.be.instanceOf(AuthzAdminFailure);
  return err as AuthzAdminFailure;
};

for (const kind of DB_KINDS) {
  describe(`DbLinkStore (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let store: DbLinkStore;
    let config: Configuration;

    const inTx = <R>(fn: (tx: AuthzTx) => Promise<R>): Promise<R> => db.driver.transaction((driver: OrmDriver) => fn({ driver }));

    const create = (l: Partial<Omit<LinkDef, 'id'>> = {}, grant: { role: string; tags?: readonly string[] } = { role: 'viewer', tags: ['comment'] }) => inTx((tx) => store.create({ scope: P1, expiresAt: AFTER, attributes: { org_only: true }, ...l }, grant, root, tx));

    const linkRows = async (): Promise<Row[]> => (await db.driver.select().from('authz_link').orderBy('id')) as Row[];
    const assignmentRows = async (): Promise<Row[]> => (await db.driver.select().from('authz_assignment').orderBy('id')) as Row[];
    const linkAssignments = async (id: string) => (await assignmentRows()).filter((r) => r.subject_type === 'link' && r.subject_id === id);
    const version = () => readVersion(db.driver, 'root');
    const resetVersion = () => rawQuery(db.driver, 'DELETE FROM authz_version', [], QueryContext.Delete);
    const setLink = (id: string, values: Row) => db.driver.update().in('authz_link').update(values).where('id', id);

    /** Counts the SELECT statements `fn` sends on the default connection. */
    const countSelects = async <R>(fn: () => Promise<R>): Promise<{ result: R; selects: number }> => {
      const target = db.driver as unknown as { executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown> };
      const original = target.executeOnDb;
      let selects = 0;
      target.executeOnDb = function (stmt, params, context) {
        if (context === QueryContext.Select) selects++;
        return original.call(this, stmt, params, context);
      };
      try {
        return { result: await fn(), selects };
      } finally {
        target.executeOnDb = original;
      }
    };

    before(async function () {
      db = await bootDb(this, kind, 'link_store', { second: true });
      await new AuthzRbac_2026_10_01_00_00_00().up(db.second!);
      db.container.register(FixedClock).as(AuthzClock);
      config = await db.container.resolve(Configuration);
      store = db.container.resolve(DbLinkStore);
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      config.set(LINK_SECRET_KEY, SECRET);
      for (const d of [db.driver, db.second!]) {
        for (const table of ['authz_link', 'authz_assignment', 'authz_version']) await rawQuery(d, `DELETE FROM ${table}`, [], QueryContext.Delete);
      }
    });

    describe('registration', () => {
      it('is an AdminLinkStore named DbLinkStore, registered by that name only', () => {
        expect(store).to.be.instanceOf(AdminLinkStore);
        expect(store).to.be.instanceOf(LinkStore);
        expect(store.name).to.eq('DbLinkStore');
        expect(db.container.resolve('DbLinkStore')).to.be.instanceOf(DbLinkStore);
        expect(DI.RootContainer.hasRegistered(LinkStore)).to.eq(false);
        expect(DI.RootContainer.hasRegistered(AdminLinkStore)).to.eq(false);
      });
    });

    describe('create', () => {
      it('returns the link and a fresh 32-byte base64url token, and writes the link row and its assignment', async () => {
        const { link, token } = await create();

        expect(token).to.match(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(token, 'base64url')).to.have.length(32);
        expect(link.id).to.match(UUID);
        expect(link).to.deep.eq({ id: link.id, scope: P1, expiresAt: AFTER, attributes: { org_only: true }, createdBy: root });

        const [row] = await linkRows();
        expect(row.id).to.eq(link.id);
        expect(row.token_hash).to.match(/^v1:[0-9a-f]{64}$/);
        expect([row.scope_type, row.scope_id]).to.deep.eq(['project', 'p1']);
        expect(JSON.parse(row.attributes as string)).to.deep.eq({ org_only: true });
        expect(toDate(row.expires_at)).to.deep.eq(AFTER);
        expect(row.revoked_at).to.eq(null);
        expect(row.created_by).to.eq('user:root');
        expect(toDate(row.created_at)).to.deep.eq(CREATED);

        const assignments = await assignmentRows();
        expect(assignments).to.have.length(1);
        const [a] = assignments;
        expect([a.subject_type, a.subject_id, a.subject_role, a.role, a.scope_type, a.scope_id, a.tags, a.granted_by, a.source]).to.deep.eq(['link', link.id, '', 'viewer', 'project', 'p1', ',comment,', 'user:root', 'db']);
        expect(toDate(a.expires_at)).to.deep.eq(AFTER);

        expect(await version()).to.eq('1');
      });

      it('gives every link its own id and token', async () => {
        const a = await create();
        const b = await create();

        expect(a.link.id).to.not.eq(b.link.id);
        expect(a.token).to.not.eq(b.token);
        expect(await version()).to.eq('2');
      });

      it('stores the token only as v1:<hex HMAC-SHA256 under the secret>, in no column of authz_link or authz_assignment', async () => {
        const { link, token } = await create();
        const raw = Buffer.from(token, 'base64url');
        const sha256 = createHash('sha256').update(token).digest('hex');

        const [row] = await linkRows();
        expect(row.token_hash).to.eq(`v1:${createHmac('sha256', SECRET).update(token).digest('hex')}`);
        expect(row.token_hash).to.not.eq(`v1:${sha256}`);

        const stored = JSON.stringify([...(await linkRows()), ...(await assignmentRows())]);
        for (const form of [token, raw.toString('hex'), raw.toString('base64'), sha256]) {
          expect(stored.includes(form), form).to.eq(false);
        }
        expect(stored.includes(link.id)).to.eq(true);
      });

      it('writes both rows in the caller transaction: a rollback removes both and the bump', async () => {
        const err = await inTx(async (tx) => {
          const { link } = await store.create({ scope: P1, attributes: {} }, { role: 'viewer' }, root, tx);
          const driver = tx.driver as OrmDriver;
          expect(await driver.select().from('authz_link').where('id', link.id)).to.have.length(1);
          expect(await driver.select().from('authz_assignment').where('subject_id', link.id)).to.have.length(1);
          throw new Error('roll back');
        }).catch((e: Error) => e);

        expect(err.message).to.eq('roll back');
        expect(await linkRows()).to.deep.eq([]);
        expect(await assignmentRows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });

      it('stores no expiry, no tags and empty attributes as null, empty and {}', async () => {
        const { link } = await create({ expiresAt: undefined, attributes: {} }, { role: 'editor' });

        expect(link).to.deep.eq({ id: link.id, scope: P1, expiresAt: null, attributes: {}, createdBy: root });
        const [row] = await linkRows();
        expect([row.expires_at, row.attributes]).to.deep.eq([null, '{}']);
        const [a] = await assignmentRows();
        expect([a.role, a.tags, a.expires_at]).to.deep.eq(['editor', '', null]);
      });

      it('takes createdBy from the actor, not from the link', async () => {
        const { link } = await create({ createdBy: alice });

        expect(link.createdBy).to.deep.eq(root);
        expect((await linkRows())[0].created_by).to.eq('user:root');
      });

      it('refuses attributes that are not a plain object, and invalid tags, before writing', async () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        for (const [i, attributes] of [null, [], 'x', 3, new Date(), { n: BigInt(1) }, cyclic].entries()) {
          const err = await failure(create({ attributes: attributes as never }));
          expect(err.code, `attributes #${i}`).to.eq('invalid_attributes');
          expect(err.field).to.eq('attributes');
        }

        const err = await failure(create({}, { role: 'viewer', tags: ['a,b'] }));
        expect(err.code).to.eq('invalid_tags');

        expect(await linkRows()).to.deep.eq([]);
        expect(await assignmentRows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });

      it('refuses GLOBAL and type-level scopes before writing', async () => {
        for (const scope of [GLOBAL, { type: 'project' }, { type: 'project', id: '' }]) {
          const err = await failure(create({ scope }));
          expect(err.code, JSON.stringify(scope)).to.eq('wrong_scope_type');
          expect(err.field).to.eq('scope');
        }

        expect(await linkRows()).to.deep.eq([]);
        expect(await assignmentRows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });
    });

    describe('byToken', () => {
      it('finds the link of the right token, and nothing for a wrong one', async () => {
        const a = await create();
        const b = await create({ scope: F1, attributes: {} });

        expect(await store.byToken(a.token)).to.deep.eq(a.link);
        expect(await store.byToken(b.token)).to.deep.eq(b.link);
        expect(await store.byToken(freshToken())).to.eq(null);
      });

      it('answers null without a query for anything but a string of 1 to 512 characters', async () => {
        const { token } = await create();

        for (const t of ['', 'x'.repeat(LINK_TOKEN_MAX_LENGTH + 1), 42 as unknown as string, null as unknown as string, undefined as unknown as string]) {
          const { result, selects } = await countSelects(() => store.byToken(t));
          expect(result, String(t).slice(0, 20)).to.eq(null);
          expect(selects, String(t).slice(0, 20)).to.eq(0);
        }

        const { result, selects } = await countSelects(() => store.byToken(token));
        expect(result).to.not.eq(null);
        expect(selects).to.eq(1);
        expect(LINK_TOKEN_MAX_LENGTH).to.eq(512);
      });

      it('looks up any other string once and finds nothing unless its hash is stored', async () => {
        const { token } = await create();
        const lastBitsSet = token.slice(0, 42) + 'B';
        const unknown = ['tok-l1', 'x', 'x'.repeat(LINK_TOKEN_MAX_LENGTH), token.slice(0, 42), token + 'A', `${token.slice(0, 42)}+`, ` ${token.slice(1)}`, lastBitsSet, token.toUpperCase()];

        for (const t of unknown) {
          const { result, selects } = await countSelects(() => store.byToken(t));
          expect(result, t.slice(0, 50)).to.eq(null);
          expect(selects, t.slice(0, 50)).to.eq(1);
        }
      });

      it('resolves a row seeded with linkTokenHash of a free-form token, as the kit harness does', async () => {
        await db.driver
          .insert()
          .into('authz_link')
          .values({ id: 'l1', token_hash: linkTokenHash(SECRET, 'tok-l1'), scope_type: 'project', scope_id: 'p1', attributes: '{}', expires_at: AFTER, revoked_at: null, created_by: null, created_at: CREATED });

        expect(await store.byToken('tok-l1')).to.deep.eq({ id: 'l1', scope: P1, expiresAt: AFTER, attributes: {} });
        expect(await store.byToken('tok-l2')).to.eq(null);
      });

      it('linkTokenHash is the stored form: v1 and the hex HMAC-SHA256 under the secret', async () => {
        const { token } = await create();

        expect(linkTokenHash(SECRET, token)).to.eq(`v1:${createHmac('sha256', SECRET).update(token).digest('hex')}`);
        expect((await linkRows())[0].token_hash).to.eq(linkTokenHash(SECRET, token));
        expect(linkTokenHash(OTHER_SECRET, token)).to.not.eq(linkTokenHash(SECRET, token));
      });

      it('answers null for the token of a revoked link', async () => {
        const { link, token } = await create();
        await inTx((tx) => store.revoke(link.id, root, tx));

        expect(await store.byToken(token)).to.eq(null);
      });

      it('returns an expired link with its expiry, for the link ceiling to deny', async () => {
        const { link, token } = await create({ expiresAt: BEFORE });

        expect(await store.byToken(token)).to.deep.eq({ ...link, expiresAt: BEFORE });
      });

      it('answers null under another secret', async () => {
        const { link, token } = await create();

        config.set(LINK_SECRET_KEY, OTHER_SECRET);
        expect(await store.byToken(token)).to.eq(null);

        config.set(LINK_SECRET_KEY, SECRET);
        expect(await store.byToken(token)).to.deep.eq(link);
      });

      it('accepts a row only when the constant-time comparison of the hashes does', async () => {
        const { token } = await create();
        const calls: [string, string][] = [];
        let answer = true;

        class Spied extends DbLinkStore {
          protected hashesEqual(stored: string, computed: string): boolean {
            calls.push([stored, computed]);
            return answer && super.hashesEqual(stored, computed);
          }
        }
        const spied = new Spied(db.container);

        expect(await spied.byToken(token)).to.not.eq(null);
        const [row] = await linkRows();
        expect(calls).to.deep.eq([[row.token_hash, row.token_hash]]);

        answer = false;
        expect(await spied.byToken(token)).to.eq(null);
        expect(calls).to.have.length(2);

        expect(await spied.byToken(freshToken())).to.eq(null);
        expect(calls, 'no row, nothing to compare').to.have.length(2);
      });

      it('compares hashes of different lengths as different, without throwing', () => {
        class Open extends DbLinkStore {
          equal(a: string, b: string) {
            return this.hashesEqual(a, b);
          }
        }
        const open = new Open(db.container);

        expect(open.equal('v1:abc', 'v1:abc')).to.eq(true);
        expect(open.equal('v1:abc', 'v1:abd')).to.eq(false);
        expect(open.equal('v1:abc', 'v1:abcd')).to.eq(false);
        expect(open.equal('', 'v1:abc')).to.eq(false);
      });
    });

    describe('byId', () => {
      it('returns a live or expired link, and null for a revoked or unknown id', async () => {
        const live = await create();
        const expired = await create({ expiresAt: BEFORE });
        const revoked = await create();
        await inTx((tx) => store.revoke(revoked.link.id, root, tx));

        expect(await store.byId(live.link.id)).to.deep.eq(live.link);
        expect(await store.byId(expired.link.id)).to.deep.eq(expired.link);
        expect(await store.byId(revoked.link.id)).to.eq(null);
        expect(await store.byId('8a1c3a54-0000-4000-8000-000000000000')).to.eq(null);
      });

      it('needs no secret', async () => {
        const { link } = await create();
        config.set(LINK_SECRET_KEY, undefined);

        expect(await store.byId(link.id)).to.deep.eq(link);
      });
    });

    describe('revoke', () => {
      it('marks the row revoked and deletes every assignment of the link, with one bump', async () => {
        const { link, token } = await create();
        const other = await create();
        // a second grant to the same link at another scope
        await inTx((tx) => db.container.resolve(DbAssignmentStore).assign({ subject: { type: 'link', id: link.id }, role: 'editor', scope: O1 }, root, tx));
        await resetVersion();

        await inTx((tx) => store.revoke(link.id, alice, tx));

        const rows = await linkRows();
        expect(rows).to.have.length(2);
        const row = rows.find((r) => r.id === link.id)!;
        expect(toDate(row.revoked_at)).to.deep.eq(CREATED);
        expect(row.token_hash).to.match(/^v1:/);
        expect(rows.find((r) => r.id === other.link.id)!.revoked_at).to.eq(null);

        expect(await linkAssignments(link.id)).to.deep.eq([]);
        expect(await linkAssignments(other.link.id)).to.have.length(1);
        expect(await version()).to.eq('1');

        expect(await store.byToken(token)).to.eq(null);
        expect(await store.byId(link.id)).to.eq(null);
      });

      it('refuses an unknown or already revoked id with not_found, without a bump', async () => {
        const { link } = await create();
        await inTx((tx) => store.revoke(link.id, root, tx));
        await resetVersion();

        for (const id of [link.id, '8a1c3a54-0000-4000-8000-000000000000']) {
          const err = await failure(inTx((tx) => store.revoke(id, root, tx)));
          expect(err.code).to.eq('not_found');
          expect(err.field).to.eq('id');
        }
        expect(await version()).to.eq('0');
      });
    });

    describe('update', () => {
      it('moves the expiry of the link and of its assignment', async () => {
        const { link, token } = await create({ expiresAt: BEFORE });
        await resetVersion();

        const updated = await inTx((tx) => store.update(link.id, { expiresAt: AFTER }, root, tx));

        expect(updated).to.deep.eq({ ...link, expiresAt: AFTER });
        expect(await store.byToken(token)).to.deep.eq(updated);
        expect(toDate((await linkAssignments(link.id))[0].expires_at)).to.deep.eq(AFTER);
        expect(await version()).to.eq('1');
      });

      it('clears the expiry with null', async () => {
        const { link } = await create();

        const updated = await inTx((tx) => store.update(link.id, { expiresAt: null }, root, tx));

        expect(updated.expiresAt).to.eq(null);
        expect((await linkRows())[0].expires_at).to.eq(null);
        expect((await linkAssignments(link.id))[0].expires_at).to.eq(null);
      });

      it('replaces the attributes and leaves the expiry alone, with one bump', async () => {
        const { link } = await create();
        await resetVersion();

        const updated = await inTx((tx) => store.update(link.id, { attributes: { org_only: false, note: 'x' } }, root, tx));

        expect(updated).to.deep.eq({ ...link, attributes: { org_only: false, note: 'x' } });
        expect(await store.byId(link.id)).to.deep.eq(updated);
        expect(toDate((await linkAssignments(link.id))[0].expires_at)).to.deep.eq(AFTER);
        expect(await version()).to.eq('1');
      });

      it('with an empty patch changes nothing and still bumps once', async () => {
        const { link } = await create();
        await resetVersion();

        expect(await inTx((tx) => store.update(link.id, {}, root, tx))).to.deep.eq(link);
        expect(await version()).to.eq('1');
      });

      it('refuses an unknown or revoked id with not_found, and invalid attributes', async () => {
        const { link } = await create();
        const live = await create();
        await inTx((tx) => store.revoke(link.id, root, tx));
        await resetVersion();

        for (const id of [link.id, 'ghost']) {
          const err = await failure(inTx((tx) => store.update(id, { expiresAt: null }, root, tx)));
          expect(err.code).to.eq('not_found');
          expect(err.field).to.eq('id');
        }

        const err = await failure(inTx((tx) => store.update(live.link.id, { attributes: [] as never }, root, tx)));
        expect(err.code).to.eq('invalid_attributes');
        expect(await store.byId(live.link.id)).to.deep.eq(live.link);
        expect(await version()).to.eq('0');
      });

      it('moves the expiry of every assignment of the link, one bump each', async () => {
        const { link } = await create();
        await inTx((tx) => db.container.resolve(DbAssignmentStore).assign({ subject: { type: 'link', id: link.id }, role: 'editor', scope: O1, expiresAt: BEFORE }, root, tx));
        await resetVersion();

        await inTx((tx) => store.update(link.id, { expiresAt: null }, root, tx));

        const rows = await linkAssignments(link.id);
        expect(rows).to.have.length(2);
        expect(rows.map((r) => r.expires_at)).to.deep.eq([null, null]);
        expect(await version()).to.eq('2');
      });

      it('does not touch a link that a concurrent transaction revoked after the read', async () => {
        const { link } = await create();
        await resetVersion();

        class Racing extends DbLinkStore {
          protected async liveRow(driver: OrmDriver, id: string) {
            const row = await super.liveRow(driver, id);
            await driver.update().in('authz_link').update({ revoked_at: BEFORE }).where('id', id);
            return row;
          }
        }
        const racing = new Racing(db.container);

        const { err, row } = await inTx(async (tx) => {
          const err = await racing.update(link.id, { expiresAt: null, attributes: { x: 1 } }, root, tx).catch((e: unknown) => e);
          const [row] = (await (tx.driver as OrmDriver).select().from('authz_link').where('id', link.id)) as Row[];
          return { err, row };
        });

        expect(err).to.be.instanceOf(AuthzAdminFailure);
        expect((err as AuthzAdminFailure).code).to.eq('not_found');
        expect(toDate(row.expires_at)).to.deep.eq(AFTER);
        expect(JSON.parse(row.attributes as string)).to.deep.eq({ org_only: true });
        expect(toDate(row.revoked_at)).to.deep.eq(BEFORE);
        expect(toDate((await linkAssignments(link.id))[0].expires_at)).to.deep.eq(AFTER);
        expect(await version()).to.eq('0');
      });

      it('works on a link created earlier in the same transaction, as does revoke', async () => {
        const { link, token } = await inTx(async (tx) => {
          const made = await store.create({ scope: P1, expiresAt: BEFORE, attributes: {} }, { role: 'viewer' }, root, tx);
          const updated = await store.update(made.link.id, { expiresAt: AFTER, attributes: { a: 1 } }, root, tx);
          expect(updated).to.deep.eq({ ...made.link, expiresAt: AFTER, attributes: { a: 1 } });
          const [a] = (await (tx.driver as OrmDriver).select().from('authz_assignment').where('subject_id', made.link.id)) as Row[];
          expect(toDate(a.expires_at)).to.deep.eq(AFTER);
          return made;
        });
        expect(await store.byToken(token)).to.deep.eq({ ...link, expiresAt: AFTER, attributes: { a: 1 } });

        await inTx(async (tx) => {
          const again = await store.create({ scope: P2, attributes: {} }, { role: 'viewer' }, root, tx);
          await store.revoke(again.link.id, root, tx);
          expect(await (tx.driver as OrmDriver).select().from('authz_assignment').where('subject_id', again.link.id)).to.deep.eq([]);
        });
        expect((await store.find({ scope: P2 })).items).to.deep.eq([]);
        expect(await version()).to.eq('4');
      });
    });

    describe('forgetScope', () => {
      it('revokes the links at the scope, expired ones too, deletes their assignments and returns them', async () => {
        const live = await create();
        const expired = await create({ expiresAt: BEFORE });
        const revoked = await create();
        const below = await create({ scope: F1 });
        const elsewhere = await create({ scope: P2 });
        await inTx((tx) => store.revoke(revoked.link.id, root, tx));
        await setLink(revoked.link.id, { revoked_at: BEFORE });
        await resetVersion();

        const gone = await inTx((tx) => store.forgetScope(P1, tx));

        expect([...gone].sort((a, b) => a.id.localeCompare(b.id))).to.deep.eq([live.link, expired.link].sort((a, b) => a.id.localeCompare(b.id)));
        expect(await store.byId(live.link.id)).to.eq(null);
        expect(await store.byId(expired.link.id)).to.eq(null);
        expect(await store.byId(below.link.id)).to.deep.eq(below.link);
        expect(await store.byId(elsewhere.link.id)).to.deep.eq(elsewhere.link);
        expect(toDate((await linkRows()).find((r) => r.id === revoked.link.id)!.revoked_at)).to.deep.eq(BEFORE);

        expect(await linkAssignments(live.link.id)).to.deep.eq([]);
        expect(await linkAssignments(expired.link.id)).to.deep.eq([]);
        expect(await linkAssignments(below.link.id)).to.have.length(1);
        expect(await version()).to.eq('1');
      });

      it('keeps the revoked_at of a link that a concurrent transaction revoked after the read', async () => {
        const { link } = await create();

        class Racing extends DbLinkStore {
          protected async liveRowsAt(driver: OrmDriver, scope: ResourceRef) {
            const rows = await super.liveRowsAt(driver, scope);
            await driver.update().in('authz_link').update({ revoked_at: BEFORE }).where('id', link.id);
            return rows;
          }
        }

        await inTx((tx) => new Racing(db.container).forgetScope(P1, tx));

        expect(toDate((await linkRows())[0].revoked_at)).to.deep.eq(BEFORE);
        expect(await linkAssignments(link.id)).to.deep.eq([]);
      });

      it('with no link at the scope returns [] and still bumps once', async () => {
        await create({ scope: P2 });
        await resetVersion();

        expect(await inTx((tx) => store.forgetScope(P1, tx))).to.deep.eq([]);
        expect(await version()).to.eq('1');
      });

      it('refuses GLOBAL and type-level refs', async () => {
        for (const scope of [GLOBAL, { type: 'project' }]) {
          const err = await failure(inTx((tx) => store.forgetScope(scope, tx)));
          expect(err.code).to.eq('wrong_scope_type');
          expect(err.field).to.eq('scope');
        }
        expect(await version()).to.eq('0');
      });
    });

    describe('find', () => {
      let made: LinkDef[];

      beforeEach(async () => {
        made = [];
        for (const [i, scope] of [P1, P1, P2, P1, F1].entries()) {
          const { link } = await create({ scope });
          await setLink(link.id, { created_at: new Date(CREATED.getTime() + 1000 * (5 - i)) });
          made.push(link);
        }
        await inTx((tx) => store.revoke(made[3].id, root, tx));
        await setLink(made[1].id, { expires_at: BEFORE });
        made[1] = { ...made[1], expiresAt: BEFORE };
      });

      it('lists the links that are not revoked, expired ones too, oldest first', async () => {
        const all = await store.find({});

        expect(all.items).to.deep.eq([made[4], made[2], made[1], made[0]]);
        expect(all.total).to.eq(4);
        expect((await store.find({ scope: P1 })).items).to.deep.eq([made[1], made[0]]);
        expect((await store.find({ scope: O1 })).items).to.deep.eq([]);
      });

      it('pages, with the total of the unpaged result', async () => {
        const res = await store.find({}, { limit: 2, offset: 1 });

        expect(res.items).to.deep.eq([made[2], made[1]]);
        expect(res.total).to.eq(4);
        expect(typeof res.total).to.eq('number');
        expect(await store.find({}, { limit: 0, offset: 0 })).to.deep.eq({ items: [], total: 4 });
      });

      it('refuses a negative or fractional page, and caps the limit', async () => {
        for (const page of [
          { limit: -1, offset: 0 },
          { limit: 1.5, offset: 0 },
          { limit: 1, offset: -1 },
        ]) {
          expect((await failure(store.find({}, page))).code).to.eq('invalid_page');
        }

        class Small extends DbLinkStore {
          protected readonly maxListLimit = 2;
        }
        const small = new Small(db.container);
        // Without a page, find returns every match: L9 reads that as the full set.
        expect(await small.find({})).to.deep.include({ total: 4 });
        expect((await small.find({})).items).to.have.length(4);
        expect(await small.find({}, { limit: 5, offset: 0 })).to.deep.include({ total: 4 });
        expect((await small.find({}, { limit: 5, offset: 0 })).items).to.have.length(2);
        expect(LINK_LIST_MAX_LIMIT).to.eq(1000);
      });
    });

    describe('the secret', () => {
      it('is required, as a string of at least 32 characters, at first use', async () => {
        const { token } = await create();

        for (const secret of [undefined, '', 'x'.repeat(31), 12345678901234567890123456789012345]) {
          config.set(LINK_SECRET_KEY, secret);
          const fresh = new DbLinkStore(db.container);

          const err = await fresh.byToken(token).catch((e: unknown) => e);
          expect(err, String(secret)).to.be.instanceOf(AuthzConfigError);
          expect((err as Error).message).to.include(LINK_SECRET_KEY);
          if (typeof secret === 'string' && secret.length > 0) expect((err as Error).message).to.not.include(secret);

          await expect(fresh.byToken(''), 'also for a token that needs no query').to.be.rejectedWith(AuthzConfigError, LINK_SECRET_KEY);
          await expect(inTx((tx) => fresh.create({ scope: P1, attributes: {} }, { role: 'viewer' }, root, tx))).to.be.rejectedWith(AuthzConfigError, LINK_SECRET_KEY);
        }

        expect(await linkRows()).to.have.length(1);
        expect(await assignmentRows()).to.have.length(1);
        expect(await version()).to.eq('1');
      });

      it('accepts exactly 32 characters', async () => {
        config.set(LINK_SECRET_KEY, 's'.repeat(32));
        const { link, token } = await create();

        expect(await store.byToken(token)).to.deep.eq(link);
      });
    });

    describe('writes outside an AuthzAdmin transaction', () => {
      it('are refused without a transaction in scope, or with something that is not a driver', async () => {
        const { link } = await create();
        const l = { scope: P1, attributes: {} };

        await expect(store.create(l, { role: 'viewer' }, root, { driver: db.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
        await expect(store.create(l, { role: 'viewer' }, root, { driver: {} })).to.be.rejectedWith(AuthzConfigError, /OrmDriver/);
        await expect(store.revoke(link.id, root, { driver: db.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
        await expect(store.update(link.id, { expiresAt: null }, root, { driver: db.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
        await expect(store.forgetScope(P1, { driver: db.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);

        expect(await store.byId(link.id)).to.deep.eq(link);
        expect(await linkRows()).to.have.length(1);
        expect(await version()).to.eq('1');
      });

      it('are refused on a transaction of another connection (D-L2-2)', async () => {
        const { link } = await create();
        const other = (fn: (tx: AuthzTx) => Promise<unknown>) => db.second!.transaction((driver: OrmDriver) => fn({ driver }));

        await expect(other((tx) => store.create({ scope: P1, attributes: {} }, { role: 'viewer' }, root, tx))).to.be.rejectedWith(AuthzConfigError, /l2-link_store-second/);
        await expect(other((tx) => store.revoke(link.id, root, tx))).to.be.rejectedWith(AuthzConfigError, /connection/);
        await expect(other((tx) => store.update(link.id, { expiresAt: null }, root, tx))).to.be.rejectedWith(AuthzConfigError, /connection/);
        await expect(other((tx) => store.forgetScope(P1, tx))).to.be.rejectedWith(AuthzConfigError, /connection/);

        for (const table of ['authz_link', 'authz_assignment', 'authz_version']) {
          expect(await rawQuery(db.second!, `SELECT * FROM ${table}`), table).to.deep.eq([]);
        }
        expect(await store.byId(link.id)).to.deep.eq(link);
        expect(await version()).to.eq('1');
      });
    });
  });
}
