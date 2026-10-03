import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, RelationResolver, SYSTEM, currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { ModelBase, QueryMiddleware } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { AccessResource, OrmScope, OrmScopePolicy, Owner, ownsBy } from '../src/index.js';
import { OrmResourceAdapter } from '../src/adapter.js';
import { maxDelegationOf, relationPrincipal } from '../src/principal.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';

const expect = chai.expect;

const user = (id: string, attributes: Record<string, unknown> = {}): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes });
const alice = user('alice', { org: 'o1' });
const bob = user('bob', { org: 'o2' });

const TYPES: Record<Dialect, { text: string; int: string }> = {
  sqlite: { text: 'TEXT', int: 'INTEGER' },
  postgres: { text: 'TEXT', int: 'INTEGER' },
};

const adapter = () => new OrmResourceAdapter();
const resolver = (type: string, relation: string): RelationResolver => {
  const r = adapter()
    .relations()
    .find((x) => x.type === type && x.relation === relation);
  if (!r) throw new Error(`no resolver for ${type}/${relation}`);
  return r;
};

describe('authz-orm relations', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const policies: (abstract new () => unknown)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.clear();
    for (const p of policies.splice(0)) DI.uncache(p as never);
  });

  // DI keys classes by name, so a same-named policy of a later case would resolve to this one.
  let seq = 0;
  const track = <P extends abstract new () => OrmScopePolicy>(policy: P): P => {
    Object.defineProperty(policy, 'name', { value: `${policy.name}_${++seq}` });
    policies.push(policy);
    return policy;
  };

  for (const dialect of ['sqlite', 'postgres'] as const) {
    describe(dialect, () => {
      const T = TYPES[dialect];
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      const rowOf = async (model: typeof ModelBase, id: string) => (await (model as any).where('id', id).first()) as ModelBase;

      describe('owner', () => {
        const defineFile = (rows: Record<string, unknown>[], ownerType = T.text) =>
          db.define(
            {
              name: 'File',
              columns: { owner: ownerType },
              rows,
              decorate: (cls, proto) => {
                AccessResource('rel-file')(cls);
                Owner()(proto, 'owner');
              },
            },
            dialect,
          );

        it('holds for the user whose id is the owner value, with and without a subject', async () => {
          const File = await defineFile([
            { id: 'f1', owner: 'alice' },
            { id: 'f2', owner: 'bob' },
            { id: 'f3', owner: null },
          ]);
          const owner = resolver('rel-file', 'owner');
          expect(owner).to.be.instanceOf(RelationResolver);
          const f1 = await rowOf(File, 'f1');
          expect(await owner.holds(alice, { type: 'rel-file', id: 'f1' }, f1)).to.equal(true);
          expect(await owner.holds(bob, { type: 'rel-file', id: 'f1' }, f1)).to.equal(false);
          expect(await owner.holds(alice, { type: 'rel-file', id: 'f1' })).to.equal(true);
          expect(await owner.holds(alice, { type: 'rel-file', id: 'f2' })).to.equal(false);
          expect(await owner.holds(bob, { type: 'rel-file', id: 'f2' })).to.equal(true);
          expect(await owner.holds(alice, { type: 'rel-file', id: 'f3' }), 'null owner').to.equal(false);
          expect(await owner.holds(user('null'), { type: 'rel-file', id: 'f3' }), 'null owner').to.equal(false);
          expect(await owner.holds(alice, { type: 'rel-file', id: 'missing' }), 'unknown row').to.equal(false);
          expect(await owner.holds(alice, { type: 'rel-file' }), 'no id').to.equal(false);
        });

        it('a principal that is not a user never owns', async () => {
          const File = await defineFile([{ id: 'f1', owner: 'alice' }]);
          const owner = resolver('rel-file', 'owner');
          const agent: Principal = { ...alice, type: 'agent' };
          expect(await owner.holds(agent, { type: 'rel-file', id: 'f1' }, await rowOf(File, 'f1'))).to.equal(false);
          expect(await owner.holds(agent, { type: 'rel-file', id: 'f1' })).to.equal(false);
          expect(await owner.holds(SYSTEM, { type: 'rel-file', id: 'f1' })).to.equal(false);
        });

        it('a numeric owner column matches the canonical number string only', async () => {
          await defineFile(
            [
              { id: 'f1', owner: 5 },
              { id: 'f2', owner: 0 },
            ],
            T.int,
          );
          const owner = resolver('rel-file', 'owner');
          expect(await owner.holds(user('5'), { type: 'rel-file', id: 'f1' })).to.equal(true);
          expect(await owner.holds(user('05'), { type: 'rel-file', id: 'f1' })).to.equal(false);
          expect(await owner.holds(user('5.0'), { type: 'rel-file', id: 'f1' })).to.equal(false);
          expect(await owner.holds(user(' 5'), { type: 'rel-file', id: 'f1' })).to.equal(false);
          expect(await owner.holds(user('0'), { type: 'rel-file', id: 'f2' })).to.equal(true);
          expect(await owner.holds(user('-0'), { type: 'rel-file', id: 'f2' })).to.equal(false);
        });

        it('a subject that is not a row of the type is ignored; the row is loaded', async () => {
          await defineFile([{ id: 'f1', owner: 'bob' }]);
          const owner = resolver('rel-file', 'owner');
          expect(await owner.holds(alice, { type: 'rel-file', id: 'f1' }, { owner: 'alice' })).to.equal(false);
          expect(await owner.holds(bob, { type: 'rel-file', id: 'f1' }, { owner: 'alice' })).to.equal(true);
        });

        it('a row subject of another id is ignored; the row of the ref is loaded', async () => {
          const File = await defineFile([
            { id: 'f1', owner: 'alice' },
            { id: 'f2', owner: 'bob' },
          ]);
          const owner = resolver('rel-file', 'owner');
          const mine = await rowOf(File, 'f1');
          expect(await owner.holds(alice, { type: 'rel-file', id: 'f2' }, mine)).to.equal(false);
          expect(await owner.holds(bob, { type: 'rel-file', id: 'f2' }, mine)).to.equal(true);
        });

        it('an @Owner on a property that is not a column is a configuration error', async () => {
          await db.define(
            {
              name: 'Ghost',
              columns: { v: T.text },
              rows: [{ id: 'g1', v: 'x' }],
              decorate: (cls, proto) => {
                AccessResource('rel-ghost')(cls);
                Owner()(proto, 'nope');
              },
            },
            dialect,
          );
          let error: unknown;
          try {
            await resolver('rel-ghost', 'owner').holds(alice, { type: 'rel-ghost', id: 'g1' });
          } catch (e) {
            error = e;
          }
          expect(error).to.be.instanceOf(AuthzConfigError);
        });

        it('one resolver per type; each row is checked against its own class owner property', async () => {
          const A = await db.define(
            {
              name: 'DocA',
              columns: { owner: T.text, author: T.text },
              rows: [{ id: 'a1', owner: 'alice', author: 'bob' }],
              decorate: (cls, proto) => {
                AccessResource('rel-doc')(cls);
                Owner()(proto, 'owner');
              },
            },
            dialect,
          );
          const B = await db.define(
            {
              name: 'DocB',
              columns: { owner: T.text, author: T.text },
              rows: [{ id: 'b1', owner: 'alice', author: 'bob' }],
              decorate: (cls, proto) => {
                AccessResource('rel-doc')(cls);
                Owner()(proto, 'author');
              },
            },
            dialect,
          );
          const C = await db.define({ name: 'DocC', columns: { owner: T.text }, rows: [{ id: 'c1', owner: 'alice' }], decorate: (cls) => AccessResource('rel-doc')(cls) }, dialect);
          expect(
            adapter()
              .relations()
              .filter((r) => r.type === 'rel-doc' && r.relation === 'owner'),
          ).to.have.length(1);
          const owner = resolver('rel-doc', 'owner');
          expect(await owner.holds(alice, { type: 'rel-doc', id: 'a1' }, await rowOf(A, 'a1'))).to.equal(true);
          expect(await owner.holds(bob, { type: 'rel-doc', id: 'a1' }, await rowOf(A, 'a1'))).to.equal(false);
          expect(await owner.holds(alice, { type: 'rel-doc', id: 'b1' }, await rowOf(B, 'b1'))).to.equal(false);
          expect(await owner.holds(bob, { type: 'rel-doc', id: 'b1' }, await rowOf(B, 'b1'))).to.equal(true);
          expect(await owner.holds(bob, { type: 'rel-doc', id: 'b1' })).to.equal(true);
          expect(await owner.holds(alice, { type: 'rel-doc', id: 'c1' }, await rowOf(C, 'c1')), 'a class without @Owner').to.equal(false);
        });
      });

      describe('@OrmScope', () => {
        const defineCampaign = (rows: Record<string, unknown>[], relation: string, policy: abstract new () => OrmScopePolicy) =>
          db.define(
            {
              name: 'Campaign',
              columns: { org: T.text },
              rows,
              decorate: (cls) => {
                AccessResource('rel-campaign')(cls);
                OrmScope(cls as never, relation)(track(policy) as never);
              },
            },
            dialect,
          );

        it('default holds: the policy scope applied to a select of the row by pk, run as SYSTEM', async () => {
          const seen: string[] = [];
          class OrgPolicy extends OrmScopePolicy {
            scope(query: IWhereBuilder<ModelBase>, principal: Principal, op: 'read' | 'update' | 'delete'): void {
              seen.push(`${op}:${currentPrincipal().type}`);
              query.where('org', principal.attributes.org as string);
            }
          }
          const Campaign = await defineCampaign(
            [
              { id: 'c1', org: 'o1' },
              { id: 'c2', org: 'o2' },
              { id: 'c3', org: null },
            ],
            'pool',
            OrgPolicy,
          );
          const pool = resolver('rel-campaign', 'pool');
          expect(pool).to.be.instanceOf(RelationResolver);
          const ref = (id: string) => ({ type: 'rel-campaign', id });
          await runWithPrincipal(alice, async () => {
            expect(await pool.holds(alice, ref('c1'), await rowOf(Campaign, 'c1'))).to.equal(true);
            expect(await pool.holds(alice, ref('c2'), await rowOf(Campaign, 'c2'))).to.equal(false);
            expect(await pool.holds(bob, ref('c2'))).to.equal(true);
            expect(await pool.holds(alice, ref('c3'))).to.equal(false);
            expect(await pool.holds(alice, ref('missing'))).to.equal(false);
          });
          expect(seen.length).to.be.greaterThan(0);
          expect(new Set(seen)).to.deep.equal(new Set(['read:system']));
        });

        it("the default holds keeps the policy's own where even when it widens with orWhere", async () => {
          class WidePolicy extends OrmScopePolicy {
            scope(query: IWhereBuilder<ModelBase>, principal: Principal): void {
              query.where('org', principal.attributes.org as string).orWhere('org', 'public');
            }
          }
          await defineCampaign(
            [
              { id: 'c1', org: 'o2' },
              { id: 'c2', org: 'public' },
            ],
            'pool',
            WidePolicy,
          );
          const pool = resolver('rel-campaign', 'pool');
          // Without its own group the policy's OR would select some other row and hold for c1.
          expect(await pool.holds(alice, { type: 'rel-campaign', id: 'c1' })).to.equal(false);
          expect(await pool.holds(alice, { type: 'rel-campaign', id: 'c2' })).to.equal(true);
        });

        it('the default holds query is not scoped by the query middleware', async () => {
          class OrgPolicy extends OrmScopePolicy {
            scope(query: IWhereBuilder<ModelBase>, principal: Principal): void {
              query.where('org', principal.attributes.org as string);
            }
          }
          await defineCampaign([{ id: 'c1', org: 'o1' }], 'pool', OrgPolicy);
          const seen: string[] = [];
          class Spy extends QueryMiddleware {
            afterQueryCreation(): void {
              seen.push(currentPrincipal().type);
            }
            beforeQueryExecution(): void {}
          }
          DI.register(Spy).as(QueryMiddleware);
          DI.uncache(QueryMiddleware);
          try {
            await runWithPrincipal(alice, async () => {
              expect(await resolver('rel-campaign', 'pool').holds(alice, { type: 'rel-campaign', id: 'c1' }, { not: 'a row' })).to.equal(true);
            });
          } finally {
            DI.unregister(Spy);
            DI.uncache(Spy);
            DI.uncache(QueryMiddleware);
          }
          expect(seen.length).to.be.greaterThan(0);
          expect(new Set(seen)).to.deep.equal(new Set(['system']));
        });

        it('a policy with holds decides in memory; without a subject the row is loaded', async () => {
          const calls: string[] = [];
          class MemoryPolicy extends OrmScopePolicy {
            scope(): void {
              calls.push('scope');
            }
            holds(principal: Principal, row: ModelBase): boolean {
              calls.push(`holds:${principal.id}:${(row as any).id}`);
              return (row as any).org === principal.attributes.org;
            }
          }
          const Campaign = await defineCampaign(
            [
              { id: 'c1', org: 'o1' },
              { id: 'c2', org: 'o2' },
            ],
            'polsat',
            MemoryPolicy,
          );
          const polsat = resolver('rel-campaign', 'polsat');
          const c1 = await rowOf(Campaign, 'c1');
          expect(await polsat.holds(alice, { type: 'rel-campaign', id: 'c1' }, c1)).to.equal(true);
          expect(await polsat.holds(alice, { type: 'rel-campaign', id: 'c2' })).to.equal(false);
          expect(await polsat.holds(bob, { type: 'rel-campaign', id: 'c2' })).to.equal(true);
          expect(await polsat.holds(bob, { type: 'rel-campaign', id: 'gone' })).to.equal(false);
          expect(calls).to.deep.equal(['holds:alice:c1', 'holds:alice:c2', 'holds:bob:c2']);
        });

        it('an async holds is awaited and only true holds', async () => {
          class AsyncPolicy extends OrmScopePolicy {
            scope(): void {}
            async holds(principal: Principal): Promise<boolean> {
              return principal.id === 'alice' ? true : ('yes' as unknown as boolean);
            }
          }
          await defineCampaign([{ id: 'c1', org: 'o1' }], 'pool', AsyncPolicy);
          const pool = resolver('rel-campaign', 'pool');
          expect(await pool.holds(alice, { type: 'rel-campaign', id: 'c1' })).to.equal(true);
          expect(await pool.holds(bob, { type: 'rel-campaign', id: 'c1' })).to.equal(false);
        });

        it('rows of a class of the type without that policy do not hold', async () => {
          class OrgPolicy extends OrmScopePolicy {
            scope(query: IWhereBuilder<ModelBase>, principal: Principal): void {
              query.where('org', principal.attributes.org as string);
            }
          }
          await defineCampaign([{ id: 'c1', org: 'o1' }], 'pool', OrgPolicy);
          const Other = await db.define({ name: 'OtherCampaign', columns: { org: T.text }, rows: [{ id: 'x1', org: 'o1' }], decorate: (cls) => AccessResource('rel-campaign')(cls) }, dialect);
          const pool = resolver('rel-campaign', 'pool');
          expect(await pool.holds(alice, { type: 'rel-campaign', id: 'c1' })).to.equal(true);
          expect(await pool.holds(alice, { type: 'rel-campaign', id: 'x1' }, await rowOf(Other, 'x1'))).to.equal(false);
          expect(await pool.holds(alice, { type: 'rel-campaign', id: 'x1' })).to.equal(false);
        });
      });

      describe('ownsBy', () => {
        it('calls fn with the subject, or with the row loaded through the adapter', async () => {
          const File = await db.define(
            {
              name: 'Note',
              columns: { author: T.text },
              rows: [
                { id: 'n1', author: 'alice' },
                { id: 'n2', author: 'bob' },
              ],
              decorate: (cls) => AccessResource('rel-note')(cls),
            },
            dialect,
          );
          const seen: unknown[] = [];
          const r = ownsBy<{ author: string }>('rel-note', 'author', (p, row) => {
            seen.push(row);
            return row.author === p.id;
          });
          expect(r).to.be.instanceOf(RelationResolver);
          expect(r.type).to.equal('rel-note');
          expect(r.relation).to.equal('author');
          expect(await r.holds(alice, { type: 'rel-note', id: 'n1' }, { author: 'alice' })).to.equal(true);
          expect(await r.holds(alice, { type: 'rel-note', id: 'n1' }, { author: 'bob' }), 'the subject wins').to.equal(false);
          expect(await r.holds(alice, { type: 'rel-note', id: 'n1' })).to.equal(true);
          expect(await r.holds(alice, { type: 'rel-note', id: 'n2' })).to.equal(false);
          expect(seen[2]).to.be.instanceOf(File);
          seen.length = 0;
          expect(await r.holds(alice, { type: 'rel-note', id: 'gone' })).to.equal(false);
          expect(await r.holds(alice, { type: 'rel-note' })).to.equal(false);
          expect(seen, 'fn is not called without a row').to.deep.equal([]);
        });
      });
    });
  }

  describe('ownsBy arguments', () => {
    it('only a true result holds', async () => {
      const r = ownsBy<unknown>('rel-any', 'x', () => 'yes' as unknown as boolean);
      expect(await r.holds(alice, { type: 'rel-any', id: '1' }, {})).to.equal(false);
    });

    it('rejects a bad type, relation or fn', () => {
      expect(() => ownsBy('', 'owner', () => true)).to.throw(AuthzConfigError);
      expect(() => ownsBy(undefined as never, 'owner', () => true)).to.throw(AuthzConfigError);
      expect(() => ownsBy('$global', 'owner', () => true)).to.throw(AuthzConfigError);
      expect(() => ownsBy('file', '', () => true)).to.throw(AuthzConfigError);
      expect(() => ownsBy('file', 7 as never, () => true)).to.throw(AuthzConfigError);
      expect(() => ownsBy('file', 'owner', undefined as never)).to.throw(AuthzConfigError);
    });
  });

  describe('adapter relations()', () => {
    it('lists the owner and @OrmScope resolvers of every registered type, live', async () => {
      class PoolPolicy extends OrmScopePolicy {
        scope(): void {}
      }
      class PolsatPolicy extends OrmScopePolicy {
        scope(): void {}
      }
      const a = adapter();
      const listed = () =>
        a
          .relations()
          .filter((r) => r.type.startsWith('rel-list-'))
          .map((r) => `${r.type}/${r.relation}`)
          .sort();
      expect(listed()).to.deep.equal([]);
      await db.define({
        name: 'Owned',
        columns: { owner: 'TEXT' },
        decorate: (cls, proto) => {
          AccessResource('rel-list-owned')(cls);
          Owner()(proto, 'owner');
        },
      });
      await db.define({
        name: 'Scoped',
        columns: { org: 'TEXT' },
        decorate: (cls) => {
          AccessResource('rel-list-scoped')(cls);
          OrmScope(cls as never, 'pool')(PoolPolicy);
          OrmScope(cls as never, 'polsat')(PolsatPolicy);
        },
      });
      await db.define({
        name: 'Both',
        columns: { owner: 'TEXT' },
        decorate: (cls, proto) => {
          AccessResource('rel-list-scoped')(cls);
          Owner()(proto, 'owner');
          OrmScope(cls as never, 'pool')(PoolPolicy);
        },
      });
      await db.define({ name: 'Bare', columns: { v: 'TEXT' }, decorate: (cls) => AccessResource('rel-list-bare')(cls) });
      expect(listed()).to.deep.equal(['rel-list-owned/owner', 'rel-list-scoped/owner', 'rel-list-scoped/polsat', 'rel-list-scoped/pool']);
    });
  });

  describe('relationPrincipal', () => {
    const cfg = () => testHost.config();
    const keys: string[][] = [];
    const set = (path: string[], value: unknown) => {
      keys.push(path);
      cfg().set(path, value);
    };
    afterEach(() => {
      for (const k of keys.splice(0).reverse()) cfg().unset(k);
    });

    const agent = (delegation: 'inherit' | 'intersect', onBehalfOf: Principal): Principal => ({ type: 'agent', id: 'bot', authenticated: true, source: 'token', attributes: {}, onBehalfOf, delegation });

    it('is the principal itself without a delegation and under intersect', () => {
      expect(relationPrincipal(alice)).to.equal(alice);
      const bot = agent('intersect', alice);
      expect(relationPrincipal(bot)).to.equal(bot);
    });

    it('is the delegate under inherit, through every inherit hop', () => {
      const p = relationPrincipal(agent('inherit', alice));
      expect(p.type).to.equal('user');
      expect(p.id).to.equal('alice');
      expect(p.attributes).to.deep.equal({ org: 'o1' });
      const twice = relationPrincipal({ ...agent('inherit', agent('inherit', alice)), id: 'outer' });
      expect([twice.type, twice.id]).to.deep.equal(['user', 'alice']);
    });

    it('maxDelegation comes from authz.engine (default 2), a domain overrides it', () => {
      expect(maxDelegationOf()).to.equal(2);
      const deep = { ...agent('inherit', { ...agent('inherit', agent('inherit', alice)), id: 'mid' }), id: 'outer' };
      expect(() => relationPrincipal(deep)).to.throw(AuthzConfigError, /maxDelegation/);
      set(['authz', 'engine', 'maxDelegation'], 3);
      expect(relationPrincipal(deep).id).to.equal('alice');
      set(['authz', 'engine', 'maxDelegation'], 0);
      expect(() => relationPrincipal(agent('inherit', alice))).to.throw(AuthzConfigError, /maxDelegation/);
      expect(relationPrincipal(alice)).to.equal(alice);
    });

    it("a child domain reads its own engine section over its lineage's", async function () {
      if (testHost.rootDomains()) this.skip();
      set(['authz', 'engine', 'maxDelegation'], 0);
      set(['authz', 'domains', 'l4t4-parent', 'engine', 'maxDelegation'], 1);
      set(['authz', 'domains', 'l4t4-child', 'parent'], 'l4t4-parent');
      expect(maxDelegationOf('root')).to.equal(0);
      expect(maxDelegationOf('l4t4-parent')).to.equal(1);
      expect(maxDelegationOf('l4t4-child'), 'from the configured parent before the host created its domains').to.equal(1);
      set(['authz', 'domains', 'l4t4-child', 'engine', 'maxDelegation'], 2);
      expect(maxDelegationOf('l4t4-child')).to.equal(2);
      expect(relationPrincipal(agent('inherit', alice), 'l4t4-parent').id).to.equal('alice');
      expect(() => relationPrincipal(agent('inherit', alice), 'root')).to.throw(AuthzConfigError);
    });

    it('uses the lineage of the created domains once the host has them', async () => {
      const domains = await testHost.domains();
      set(['authz', 'engine', 'maxDelegation'], 0);
      set(['authz', 'domains', 'l4t4-p', 'engine', 'maxDelegation'], 1);
      const parent = domains.create('l4t4-p');
      try {
        domains.create('l4t4-c', 'l4t4-p');
        expect(maxDelegationOf('l4t4-c')).to.equal(1);
        expect(() => maxDelegationOf('l4t4-unknown')).to.throw(AuthzConfigError);
      } finally {
        await parent.dispose();
      }
    });
  });
});
