import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzAdminFailure, AuthzClock, MemoryAuthzAdminBackend } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { OrmDriver, QueryContext } from '@spinajs/orm';

import { DbAssignmentStore, DbLinkStore, DbRuleStore, LINK_SECRET_KEY, MemoryAdminAssignmentStore, MemoryLinkStore, MemoryRuleStore, subjectFromColumns, subjectKeyOf } from '../../src/index.js';
import type { RuleDef } from '../../src/index.js';
import { bootDb, DB_KINDS, rawQuery, TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const AT = new Date('2026-10-01T12:00:00.000Z');
const BEFORE = new Date(AT.getTime() - 1000);
const BASE = new Date('2026-09-30T08:15:30.250Z');
const SECRET = 'keyset-link-secret-0123456789abcdef';

const P1: ResourceRef = { type: 'project', id: 'p1' };
const root: PrincipalRef = { type: 'user', id: 'root' };
const alice: PrincipalRef = { type: 'user', id: 'alice' };

type Row = Record<string, unknown>;
interface Listed {
  readonly items: readonly { readonly id: string }[];
  readonly total: number;
  readonly next?: string;
}

/** Four rows share each timestamp, so the id tie-break decides inside a group. */
const stamp = (i: number, group = 4): Date => new Date(BASE.getTime() + Math.floor(i / group) * 1000);
const pad = (n: number): string => String(n).padStart(2, '0');
const ids = (page: Listed): string[] => page.items.map((x) => x.id);
const cursorOf = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** Follows `next` from the first page until a page has none. */
async function walk(fetch: (after: string | undefined) => Promise<Listed>): Promise<Listed[]> {
  const pages: Listed[] = [];
  for (let after: string | undefined; ; ) {
    const page = await fetch(after);
    pages.push(page);
    if (page.next === undefined) return pages;
    expect(pages.length, 'the cursor never ends').to.be.lessThan(30);
    after = page.next;
  }
}

const window = (limit: number, after: string | undefined) => ({ limit, offset: 0, ...(after === undefined ? {} : { after }) });

async function refused(p: Promise<unknown>): Promise<AuthzAdminFailure> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).to.be.instanceOf(AuthzAdminFailure);
  return err as AuthzAdminFailure;
}

const MALFORMED = ['', 'not base64url!', cursorOf('no-separator'), cursorOf('not-a-date|a00'), cursorOf(`${BASE.toISOString()}|`)];

let now = BASE;

class SteppedClock extends AuthzClock {
  now(): Date {
    return now;
  }
}

for (const kind of DB_KINDS) {
  describe(`keyset pagination on the DB stores (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let assignments: DbAssignmentStore;
    let links: DbLinkStore;
    let rules: DbRuleStore;

    const inTx = <R>(fn: (tx: AuthzTx) => Promise<R>): Promise<R> => db.driver.transaction((driver: OrmDriver) => fn({ driver }));

    const row = (i: number, over: Row = {}): Row => {
      const r = { id: `a${pad(i)}`, subject_type: 'user', subject_id: `u${pad(i)}`, subject_role: '', role: 'viewer', scope_type: 'project', scope_id: 'p1', tags: '', expires_at: null, granted_by: null, source: 'db', created_at: stamp(i), ...over };
      return { subject_key: subjectKeyOf(subjectFromColumns(String(r.subject_type), String(r.subject_id), String(r.subject_role))), ...r };
    };

    const seed = async (...rows: Row[]) => {
      await db.driver
        .insert()
        .into('authz_assignment')
        .values(rows);
    };

    /** `a24`..`a00` get timestamps in the opposite id order within a group, so created_at and id disagree. */
    const seed25 = () => seed(...Array.from({ length: 25 }, (_, i) => row(i, { id: `a${pad(24 - i)}` })));

    /** What an unpaged ordered read returns: the order every page must follow. */
    const order = (): string[] =>
      Array.from({ length: 25 }, (_, i) => ({ id: `a${pad(24 - i)}`, at: stamp(i).getTime() }))
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
        .map((r) => r.id);

    const listAssignments = (limit: number, after?: string, over: Record<string, unknown> = {}) => assignments.list({ scope: P1, ...over, page: window(limit, after) }, AT);

    before(async function () {
      db = await bootDb(this, kind, 'keyset');
      db.container.register(SteppedClock).as(AuthzClock);
      (await db.container.resolve(Configuration)).set(LINK_SECRET_KEY, SECRET);
      assignments = db.container.resolve(DbAssignmentStore);
      links = db.container.resolve(DbLinkStore);
      rules = db.container.resolve(DbRuleStore);
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      now = BASE;
      for (const table of ['authz_rule_subject', 'authz_rule', 'authz_link', 'authz_assignment', 'authz_version']) await rawQuery(db.driver, `DELETE FROM ${table}`, [], QueryContext.Delete);
    });

    describe('assignments', () => {
      it('returns every row once, in (created_at, id) order, over three pages of 10', async () => {
        await seed25();
        const pages = await walk((after) => listAssignments(10, after));

        expect(pages.map((p) => p.items.length)).to.deep.eq([10, 10, 5]);
        expect(pages.flatMap(ids)).to.deep.eq(order());
        expect(new Set(pages.flatMap(ids)).size).to.eq(25);
        expect(pages.every((p) => p.total === 25)).to.eq(true);
      });

      it('does not duplicate or skip rows when rows are inserted between page reads', async () => {
        await seed25();
        const first = await listAssignments(10);
        expect(first.next).to.be.a('string');

        await seed(row(90, { id: 'a90', created_at: new Date(BASE.getTime() - 5000) }), row(91, { id: 'a91', created_at: new Date(BASE.getTime() + 5500) }));
        const rest = await walk((after) => listAssignments(10, after ?? first.next));

        const seen = [...ids(first), ...rest.flatMap(ids)];
        expect(new Set(seen).size, 'no row twice').to.eq(seen.length);
        // The older row sorts before the cursor and stays unseen; the later one lands in the unread part.
        const expected = [...order().map((id) => ({ id, at: stamp(24 - Number(id.slice(1))).getTime() })), { id: 'a91', at: BASE.getTime() + 5500 }].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
        expect(seen).to.deep.eq(expected.map((r) => r.id));
      });

      it('omits next on the last page, also when that page is full', async () => {
        await seed25();

        const whole = await listAssignments(25);
        expect(whole.items).to.have.length(25);
        expect(whole).to.not.have.property('next');

        const fives = await walk((after) => listAssignments(5, after));
        expect(fives).to.have.length(5);
        expect(fives.slice(0, 4).every((p) => typeof p.next === 'string')).to.eq(true);
        expect(fives[4]).to.not.have.property('next');
      });

      it('keeps offset requests working and gives them no cursor', async () => {
        await seed25();

        const page = await assignments.list({ scope: P1, page: { limit: 10, offset: 10 } }, AT);

        expect(ids(page)).to.deep.eq(order().slice(10, 20));
        expect(page.total).to.eq(25);
        expect(page).to.not.have.property('next');
      });

      it('answers the whole result without a page, with no cursor', async () => {
        await seed25();

        const all = await assignments.find({ at: AT, scope: P1 });

        expect(all.items.map((a) => a.id)).to.deep.eq(order());
        expect(all).to.not.have.property('next');
      });

      it('find takes the cursor as list does', async () => {
        await seed25();
        const pages = await walk((after) => assignments.find({ at: AT, scope: P1 }, window(10, after)));

        expect(pages.flatMap(ids)).to.deep.eq(order());
      });

      it('applies the filters to every page: expired rows stay out unless asked for', async () => {
        await seed25();
        await seed(row(80, { id: 'a80', created_at: stamp(3), expires_at: BEFORE }), row(81, { id: 'a81', created_at: stamp(12), expires_at: BEFORE }));

        const live = await walk((after) => listAssignments(10, after));
        expect(live.flatMap(ids)).to.deep.eq(order());

        const all = await walk((after) => listAssignments(10, after, { includeExpired: true }));
        expect(all.flatMap(ids)).to.have.length(27);
        expect(all.flatMap(ids)).to.include.members(['a80', 'a81']);
        expect(all[0].total).to.eq(27);
      });

      it('refuses a cursor together with an offset, as invalid_page on page.after', async () => {
        await seed25();
        const { next } = await listAssignments(10);

        const err = await refused(assignments.list({ scope: P1, page: { limit: 10, offset: 5, after: next } }, AT));

        expect(err.code).to.eq('invalid_page');
        expect(err.field).to.eq('page.after');
      });

      it('refuses a malformed cursor as invalid_page on page.after', async () => {
        await seed25();

        for (const after of MALFORMED) {
          const err = await refused(listAssignments(10, after));
          expect(err.code, JSON.stringify(after)).to.eq('invalid_page');
          expect(err.field, JSON.stringify(after)).to.eq('page.after');
        }
      });
    });

    describe('links', () => {
      const create = async (n: number) => {
        for (let i = 0; i < n; i++) {
          now = stamp(i, 3);
          await inTx((tx) => links.create({ scope: P1, expiresAt: null, attributes: {} }, { role: 'viewer' }, root, tx));
        }
      };

      it('pages 12 links once each in the order of an unpaged read', async () => {
        await create(12);
        const oracle = await links.find({});

        const pages = await walk((after) => links.find({}, window(5, after)));

        expect(pages.map((p) => p.items.length)).to.deep.eq([5, 5, 2]);
        expect(pages.flatMap(ids)).to.deep.eq(oracle.items.map((l) => l.id));
        expect(pages[2]).to.not.have.property('next');
        expect(pages.every((p) => p.total === 12)).to.eq(true);
      });

      it('leaves a revoked link out of every page and survives its revocation between reads', async () => {
        await create(12);
        const oracle = (await links.find({})).items.map((l) => l.id);
        const first = await links.find({}, window(5, undefined));

        await inTx((tx) => links.revoke(oracle[5], root, tx));
        const rest = await walk((after) => links.find({}, window(5, after ?? first.next)));

        expect([...ids(first), ...rest.flatMap(ids)]).to.deep.eq(oracle.filter((id) => id !== oracle[5]));
      });

      it('keeps offset requests working and refuses a bad cursor', async () => {
        await create(12);
        const oracle = (await links.find({})).items.map((l) => l.id);

        const page = await links.find({}, { limit: 5, offset: 5 });
        expect(ids(page)).to.deep.eq(oracle.slice(5, 10));
        expect(page).to.not.have.property('next');

        for (const after of MALFORMED) expect((await refused(links.find({}, window(5, after)))).field, JSON.stringify(after)).to.eq('page.after');
        expect((await refused(links.find({}, { limit: 5, offset: 1, after: cursorOf(`${BASE.toISOString()}|x`) }))).code).to.eq('invalid_page');
      });
    });

    describe('rules', () => {
      const rule = (i: number): RuleDef => ({ id: `r${pad(i)}`, kind: 'restrict', scope: P1, allow: [alice], expiresAt: null, source: 'db' });
      const put = async (n: number) => {
        for (let i = 0; i < n; i++) {
          now = stamp(i, 3);
          await inTx((tx) => rules.put(rule(i), root, tx));
        }
      };

      it('pages 12 rules once each in (created_at, id) order', async () => {
        await put(12);

        const pages = await walk((after) => rules.list({ page: window(5, after) }));

        expect(pages.map((p) => p.items.length)).to.deep.eq([5, 5, 2]);
        expect(pages.flatMap(ids)).to.deep.eq(Array.from({ length: 12 }, (_, i) => `r${pad(i)}`));
        expect(pages[2]).to.not.have.property('next');
      });

      it('find takes the cursor, and a cursor with an offset is invalid_page', async () => {
        await put(12);
        const first = await rules.find({ scope: P1 }, window(5, undefined));

        expect(ids(await rules.find({ scope: P1 }, window(5, first.next)))).to.deep.eq(['r05', 'r06', 'r07', 'r08', 'r09']);
        expect((await refused(rules.find({ scope: P1 }, { limit: 5, offset: 2, after: first.next }))).field).to.eq('page.after');
        expect(ids(await rules.list({ page: { limit: 5, offset: 5 } }))).to.deep.eq(['r05', 'r06', 'r07', 'r08', 'r09']);
      });

      it('refuses a malformed cursor', async () => {
        await put(3);

        for (const after of MALFORMED) expect((await refused(rules.list({ page: window(5, after) }))).field, JSON.stringify(after)).to.eq('page.after');
      });
    });
  });
}

describe('keyset pagination on the memory stores', () => {
  let backend: MemoryAuthzAdminBackend;
  let assignments: MemoryAdminAssignmentStore;
  let links: MemoryLinkStore;
  let rules: MemoryRuleStore;

  const inTx = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => {
    let out: T;
    return backend.transaction('test', async (tx) => void (out = await fn(tx))).then(() => out);
  };
  const grant = (n: number) => inTx((tx) => assignments.assign({ subject: { type: 'user', id: `u${pad(n)}` }, role: 'viewer', scope: P1, tags: [], expiresAt: null }, root, tx));

  beforeEach(() => {
    backend = new MemoryAuthzAdminBackend();
    assignments = new MemoryAdminAssignmentStore();
    links = new MemoryLinkStore(assignments);
    rules = new MemoryRuleStore();
  });

  it('pages 25 assignments once each in listing order', async () => {
    const all: string[] = [];
    for (let i = 0; i < 25; i++) all.push((await grant(i)).id);

    const pages = await walk((after) => assignments.find({ at: AT, scope: P1 }, window(10, after)));

    expect(pages.map((p) => p.items.length)).to.deep.eq([10, 10, 5]);
    expect(pages.flatMap(ids)).to.deep.eq(all);
    expect(pages[2]).to.not.have.property('next');
  });

  it('survives the deletion of the last row read, and a row added between reads', async () => {
    const all: string[] = [];
    for (let i = 0; i < 25; i++) all.push((await grant(i)).id);
    const first = await assignments.find({ at: AT, scope: P1 }, window(10, undefined));

    await inTx((tx) => assignments.revoke(all[9], root, tx));
    const added = await grant(40);
    const rest = await walk((after) => assignments.find({ at: AT, scope: P1 }, window(10, after ?? first.next)));

    expect([...ids(first), ...rest.flatMap(ids)]).to.deep.eq([...all, added.id]);
  });

  it('keeps offset requests working and refuses a bad cursor or a cursor with an offset', async () => {
    const all: string[] = [];
    for (let i = 0; i < 12; i++) all.push((await grant(i)).id);

    const page = await assignments.find({ at: AT, scope: P1 }, { limit: 5, offset: 5 });
    expect(ids(page)).to.deep.eq(all.slice(5, 10));
    expect(page).to.not.have.property('next');

    const { next } = await assignments.find({ at: AT, scope: P1 }, window(5, undefined));
    for (const after of [...MALFORMED, 'AAAA']) expect((await refused(assignments.find({ at: AT, scope: P1 }, window(5, after)))).code, JSON.stringify(after)).to.eq('invalid_page');
    expect((await refused(assignments.find({ at: AT, scope: P1 }, { limit: 5, offset: 1, after: next }))).field).to.eq('page.after');
  });

  it('pages links and rules once each in listing order', async () => {
    const linkIds: string[] = [];
    for (let i = 0; i < 7; i++) linkIds.push((await inTx((tx) => links.create({ scope: P1, expiresAt: null, attributes: {} }, { role: 'viewer' }, root, tx))).link.id);
    for (let i = 0; i < 7; i++) await inTx((tx) => rules.put({ id: `r${pad(i)}`, kind: 'restrict', scope: P1, allow: [alice], expiresAt: null }, root, tx));

    const linkPages = await walk((after) => links.find({}, window(3, after)));
    const rulePages = await walk((after) => rules.find({}, window(3, after)));

    expect(linkPages.map((p) => p.items.length)).to.deep.eq([3, 3, 1]);
    expect(linkPages.flatMap(ids)).to.deep.eq(linkIds);
    expect(rulePages.flatMap(ids)).to.deep.eq(Array.from({ length: 7 }, (_, i) => `r${pad(i)}`));
    expect(rulePages[2]).to.not.have.property('next');
  });
});
