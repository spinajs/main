import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzAdminFailure, AuthzConfigError, AuthzDomains, GLOBAL, principalKey } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { OrmDriver, QueryContext } from '@spinajs/orm';

import { bumpVersion, normaliseTags, parsePrincipalKey, parseTags, readVersion, scopeFromColumns, scopeToColumns, storeDomain, subjectFromColumns, subjectToColumns, toDate, transactionDriver } from '../../src/index.js';
import { bootDb, DB_KINDS, rawQuery, TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('store helpers', () => {
  describe('tags (D-L2-6)', () => {
    it('normalise to sorted, deduplicated ,a,b, text; none is the empty text', () => {
      expect(normaliseTags(['b', 'a', 'a'])).to.eq(',a,b,');
      expect(normaliseTags(['x'])).to.eq(',x,');
      expect(normaliseTags([])).to.eq('');
      expect(normaliseTags(undefined)).to.eq('');
      expect(normaliseTags(['50%', 'a_b'])).to.eq(',50%,a_b,');
    });

    it('refuse an empty tag, a tag with the separator or a non-string, naming it', () => {
      for (const [tags, named] of [
        [[''], '""'],
        [['a,b'], '"a,b"'],
        [[1 as unknown as string], '1'],
      ] as const) {
        expect(() => normaliseTags(tags), named).to.throw(AuthzAdminFailure, named);
      }
      try {
        normaliseTags(['a,b']);
      } catch (e) {
        expect((e as AuthzAdminFailure).code).to.eq('invalid_tags');
        expect((e as AuthzAdminFailure).field).to.eq('tags');
      }
    });

    it('parse back to the sorted list; the empty text is no tags', () => {
      expect(parseTags(',a,b,')).to.deep.eq(['a', 'b']);
      expect(parseTags('')).to.deep.eq([]);
      expect(parseTags(null)).to.deep.eq([]);
    });
  });

  describe('subject and scope columns (D-L2-7)', () => {
    it('map a principal to (type, id, "") and back', () => {
      expect(subjectToColumns({ type: 'user', id: 'u1' })).to.deep.eq({ subject_type: 'user', subject_id: 'u1', subject_role: '' });
      expect(subjectFromColumns('user', 'u1', '')).to.deep.eq({ type: 'user', id: 'u1' });
    });

    it('map a subject set to (scope type, scope id, role) and back', () => {
      const set = { set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } };
      expect(subjectToColumns(set)).to.deep.eq({ subject_type: 'group', subject_id: 'g1', subject_role: 'group.member' });
      expect(subjectFromColumns('group', 'g1', 'group.member')).to.deep.eq(set);
    });

    it('refuse a subject set with an empty role', () => {
      expect(() => subjectToColumns({ set: { role: '', scope: { type: 'group', id: 'g1' } } })).to.throw(AuthzConfigError);
    });

    it('map GLOBAL to ($global, "") and a type-level ref to (type, "")', () => {
      expect(scopeToColumns(GLOBAL)).to.deep.eq({ scope_type: '$global', scope_id: '' });
      expect(scopeFromColumns('$global', '')).to.eq(GLOBAL);
      expect(scopeToColumns({ type: 'project', id: 'p1' })).to.deep.eq({ scope_type: 'project', scope_id: 'p1' });
      expect(scopeFromColumns('project', 'p1')).to.deep.eq({ type: 'project', id: 'p1' });
      expect(scopeToColumns({ type: 'project' })).to.deep.eq({ scope_type: 'project', scope_id: '' });
      expect(scopeFromColumns('project', '')).to.deep.eq({ type: 'project' });
    });

    it('parse principalKey() back, a type with ":" or "%" included', () => {
      for (const p of [
        { type: 'user', id: 'u1' },
        { type: 'user', id: 'a:b' },
        { type: 'odd:type%', id: 'x' },
      ]) {
        expect(parsePrincipalKey(principalKey(p))).to.deep.eq(p);
      }
      expect(parsePrincipalKey('no-separator')).to.eq(undefined);
      expect(parsePrincipalKey(null)).to.eq(undefined);
    });

    it('read dates from Date values and from SQLite local wall-clock text', () => {
      const d = new Date(2026, 9, 1, 14, 0, 0, 250);
      expect(toDate(d)).to.eq(d);
      expect(toDate('2026-10-01 14:00:00.250')!.getTime()).to.eq(d.getTime());
      expect(toDate('2026-10-01 14:00:00')!.getTime()).to.eq(new Date(2026, 9, 1, 14).getTime());
      expect(toDate('2026-10-01T12:00:00.000Z')!.getTime()).to.eq(Date.UTC(2026, 9, 1, 12));
      expect(toDate(null)).to.eq(null);
      expect(() => toDate('yesterday')).to.throw(/yesterday/);
    });
  });

  describe('storeDomain (D-L2-3)', () => {
    let domain: IContainer | undefined;

    after(async () => {
      await domain?.dispose();
    });

    it('is root outside an authz domain and the domain name inside one', () => {
      expect(storeDomain(DI.child())).to.eq('root');

      domain = DI.resolve(AuthzDomains).create('l2_t3_domain');
      expect(storeDomain(domain)).to.eq('l2_t3_domain');
      expect(storeDomain(domain.child())).to.eq('l2_t3_domain');
    });
  });

  describe('transactionDriver (D-L2-1)', () => {
    it('refuses a tx without an OrmDriver', () => {
      expect(() => transactionDriver({ driver: {} }, 'test')).to.throw(AuthzConfigError, /OrmDriver/);
      expect(() => transactionDriver({ driver: undefined }, 'test')).to.throw(AuthzConfigError, /OrmDriver/);
    });
  });
});

for (const kind of DB_KINDS) {
  describe(`authz_version helpers (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'version_helpers');
    });

    after(async () => {
      await db?.dispose();
    });

    it('read 0 for an absent domain, create the row at 1, bump by one, keep domains apart', async () => {
      expect(await readVersion(db.driver, 'root')).to.eq('0');

      await db.driver.transaction(async (d: OrmDriver) => bumpVersion(d, 'root'));
      expect(await readVersion(db.driver, 'root')).to.eq('1');

      await db.driver.transaction(async (d: OrmDriver) => {
        await bumpVersion(d, 'root');
        await bumpVersion(d, 'tenant');
      });

      expect(await readVersion(db.driver, 'root')).to.eq('2');
      expect(await readVersion(db.driver, 'tenant')).to.eq('1');

      const rows = (await rawQuery(db.driver, 'SELECT domain, version FROM authz_version ORDER BY domain', [], QueryContext.Select)) as { domain: string; version: unknown }[];
      expect(rows.map((r) => [r.domain, String(r.version)])).to.deep.eq([
        ['root', '2'],
        ['tenant', '1'],
      ]);
    });

    it('bumpVersion refuses to run outside a transaction', async () => {
      await expect(bumpVersion(db.driver, 'root')).to.be.rejectedWith(AuthzConfigError, /transaction/);
    });
  });
}
