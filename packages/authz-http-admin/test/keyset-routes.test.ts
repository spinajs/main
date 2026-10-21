import 'mocha';
import { expect } from 'chai';
import type { AdminContext, AuthzAdminQuery } from '@spinajs/authz';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, World } from '@spinajs/authz-testing';
import { RbacAdminReader } from '../../authz-rbac/src/index.js';

import { adminHttpHarness, send } from './support/admin-http.js';
import type { RawRequest } from './support/admin-http.js';

const { assignment, combine, ref, role } = fixtureDsl;

const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');

const TYPES = ['org', 'project'];
const MANAGE = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage', 'authz:policies.manage'];
const READ = ['authz:assignments.read', 'authz:links.read', 'authz:rules.read', 'authz:policies.read', 'authz:holders.read'];

const root = userPrincipal('root');

const world: World = {
  now: new Date('2026-01-01T00:00:00.000Z'),
  permissions: ['file:read', 'file:edit', ...MANAGE, ...READ].map((name) => ({ name, types: TYPES })),
  principals: { root },
  scopes: [{ nodes: [{ ref: P1, parent: O1 }] }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [{ name: 'project', roles: ['viewer', 'editor'] }],
    roles: [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:read', 'file:edit'], { ladder: 'project' }), role('superuser', ['file:read', 'file:edit', ...MANAGE, ...READ])],
    assignments: [assignment('r1', root, 'superuser'), assignment('r2', root, 'editor')],
  },
};

interface Answer {
  readonly status: number;
  readonly body: {
    readonly items: readonly { readonly id: string; readonly subject: { readonly id: string } }[];
    readonly total: number;
    readonly next?: string;
    readonly results: readonly { readonly id: string }[];
    readonly error: { readonly code: string; readonly field?: string };
  };
}

async function call(method: RawRequest['method'], path: string, body?: unknown): Promise<Answer> {
  const res = await send({ method, path, as: root, ...(body === undefined ? {} : { body }) });
  return { status: res.status, body: res.body };
}

const pad = (n: number): string => String(n).padStart(2, '0');
const users = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => `u${pad(from + i)}`);
const subjects = (answer: Answer): string[] => answer.body.items.map((i) => i.subject.id);
const itemIds = (answer: Answer): string[] => answer.body.items.map((i) => i.id);
const withCursor = (path: string, next: string | undefined): string => `${path}&after=${encodeURIComponent(next ?? '')}`;

describe('authz-http-admin keyset pagination', function () {
  this.timeout(30000);

  let harness: BehaviourHarness;
  let session: HarnessSession | undefined;
  let caseNo = 0;

  before(async () => {
    harness = adminHttpHarness();
    await harness.beforeAll?.();
  });

  after(async () => {
    await harness.afterAll?.();
  });

  beforeEach(async function () {
    const title = this.currentTest?.fullTitle() ?? `case ${++caseNo}`;
    session = await harness.setup(world, { id: 'B43', part: 'keyset', case: title, title, facets: ['http', 'engine', 'rbac', 'admin'] });
  });

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  const seed = async (from: number, to: number) => {
    const commands = users(from, to).map((id) => ({ kind: 'assignment.grant', subject: { type: 'user', id }, role: 'viewer', scope: P1 }));
    const res = await call('POST', '/authz/commands', { commands });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
  };

  const filter = 'scope=project:p1&role=viewer';

  async function pagesOf(base: string, limit: number): Promise<Answer[]> {
    const pages: Answer[] = [];
    let path = `${base}${base.includes('?') ? '&' : '?'}limit=${limit}`;
    for (;;) {
      const res = await call('GET', path);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      pages.push(res);
      if (res.body.next === undefined) return pages;
      expect(pages.length, 'the cursor never ends').to.be.lessThan(20);
      path = withCursor(`${base}${base.includes('?') ? '&' : '?'}limit=${limit}`, res.body.next);
    }
  }

  describe('assignments', () => {
    it('returns every row once over three pages of 10 and gives no next on the last', async () => {
      await seed(0, 25);

      const pages = await pagesOf(`/authz/assignments?${filter}`, 10);

      expect(pages.map((p) => p.body.items.length)).to.deep.equal([10, 10, 5]);
      expect(pages.flatMap(subjects)).to.deep.equal(users(0, 25));
      expect(pages.map((p) => typeof p.body.next)).to.deep.equal(['string', 'string', 'undefined']);
      expect(pages.every((p) => p.body.total === 25)).to.equal(true);
    });

    it('does not duplicate or skip rows when a row is added between page reads', async () => {
      await seed(0, 25);
      const base = `/authz/assignments?${filter}&limit=10`;
      const first = await call('GET', base);

      await seed(90, 91);
      const second = await call('GET', withCursor(base, first.body.next));
      const third = await call('GET', withCursor(base, second.body.next));

      expect([...subjects(first), ...subjects(second), ...subjects(third)]).to.deep.equal([...users(0, 25), 'u90']);
    });

    it('keeps offset paging working and answers no cursor for it', async () => {
      await seed(0, 25);

      const res = await call('GET', `/authz/assignments?${filter}&limit=10&offset=10`);

      expect(res.status).to.equal(200);
      expect(subjects(res)).to.deep.equal(users(10, 20));
      expect(res.body.total).to.equal(25);
      expect(res.body).to.not.have.property('next');
    });

    it('answers 400 invalid_query for a cursor with an offset, an empty cursor and a cursor given twice', async () => {
      await seed(0, 25);
      const { next } = (await call('GET', `/authz/assignments?${filter}&limit=10`)).body;

      for (const q of [`after=${next}&offset=5`, 'after=', `after=${next}&after=${next}`]) {
        const res = await call('GET', `/authz/assignments?${filter}&limit=10&${q}`);
        expect(res.status, q).to.equal(400);
        expect(res.body.error, q).to.deep.include({ code: 'invalid_query', field: 'after' });
      }
    });

    it('answers 400 invalid_page for a cursor the store cannot read', async () => {
      await seed(0, 3);

      const res = await call('GET', `/authz/assignments?${filter}&limit=10&after=${Buffer.from('nope', 'utf8').toString('base64url')}`);

      expect(res.status).to.equal(400);
      expect(res.body.error).to.deep.include({ code: 'invalid_page', field: 'page.after' });
    });
  });

  describe('links', () => {
    it('pages 12 links once each, in creation order', async () => {
      const created: string[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await call('POST', '/authz/links', { scope: P1, role: 'viewer' });
        expect(res.status, JSON.stringify(res.body)).to.equal(200);
        created.push(res.body.results[0].id);
      }

      const pages = await pagesOf('/authz/links?scope=project:p1', 5);

      expect(pages.map((p) => p.body.items.length)).to.deep.equal([5, 5, 2]);
      expect(pages.flatMap(itemIds)).to.deep.equal(created);
      expect(pages[2].body).to.not.have.property('next');
    });
  });

  describe('rules', () => {
    it('pages 7 rules once each', async () => {
      for (let i = 0; i < 7; i++) {
        const res = await call('PUT', `/authz/rules/r${pad(i)}`, { kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor' });
        expect(res.status, JSON.stringify(res.body)).to.equal(200);
      }

      const pages = await pagesOf('/authz/rules?scope=project:p1', 3);

      expect(pages.map((p) => p.body.items.length)).to.deep.equal([3, 3, 1]);
      expect(pages.flatMap(itemIds)).to.deep.equal(Array.from({ length: 7 }, (_, i) => `r${pad(i)}`));
    });
  });

  describe('holders', () => {
    it('hands the cursor to the reader and answers its next', async () => {
      // The harness model is not an RbacModel, so the reader is stubbed: this tests the route, not the RBAC answer.
      const seen: AuthzAdminQuery[] = [];
      const original = Reflect.get(RbacAdminReader.prototype, 'list');
      RbacAdminReader.prototype.list = async function (this: RbacAdminReader, q: AuthzAdminQuery, ctx: AdminContext) {
        if (q.kind !== 'holders') return original.call(this, q, ctx);
        seen.push(q);
        return { items: [{ subject: { type: 'user', id: 'root' }, via: [] }], total: 3, next: 'bmV4dA' };
      };
      try {
        const res = await call('GET', '/authz/holders?scope=project:p1&permission=file:edit&limit=10&after=abc');

        expect(res.status, JSON.stringify(res.body)).to.equal(200);
        expect(res.body.next).to.equal('bmV4dA');
        expect(seen.map((q) => (q.kind === 'holders' ? q.page : undefined))).to.deep.equal([{ limit: 10, offset: 0, after: 'abc' }]);

        const both = await call('GET', '/authz/holders?scope=project:p1&permission=file:edit&after=abc&offset=1');
        expect(both.status).to.equal(400);
        expect(both.body.error).to.deep.include({ code: 'invalid_query', field: 'after' });
      } finally {
        RbacAdminReader.prototype.list = original;
      }
    });
  });

  describe('policies', () => {
    it('refuses a cursor: the policy reader pages by offset only', async () => {
      const res = await call('GET', '/authz/policies?after=abc');

      expect(res.status).to.equal(400);
      expect(res.body.error).to.deep.include({ code: 'invalid_query', field: 'after' });
    });
  });
});
