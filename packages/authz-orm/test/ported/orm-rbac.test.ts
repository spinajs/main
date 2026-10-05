import * as chai from 'chai';
import 'mocha';

import { AccessDenied, authzStorage } from '@spinajs/authz';
import type { Principal, ResourceFilter } from '@spinajs/authz';
import { Forbidden } from '@spinajs/exceptions';
import { BelongsTo, ModelBase } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import { DI } from '@spinajs/di';

import { AccessResource, OrmScope, OrmScopePolicy } from '../../src/index.js';
import type { Dialect } from '../support/db.js';
import { asSystem } from '../support/system.js';
import { DIALECTS, PortedWorld, as, ownerRelation, permit, user } from './harness.js';

const expect = chai.expect;

type Static = typeof ModelBase & { query(): any; where(...a: unknown[]): any };

// Ported from users legacy-v2/orm-rbac.test.ts (B20, B15, B01, B09, B21): ORM query constraints and
// the relation JOIN ON scoping. The 2.x `TestClientPolicy.scope` is an @OrmScope policy over the
// `pool` relation, which `clients:read` is permitted under.
describe('Orm rbac test', function () {
  this.timeout(60000);
  const w = new PortedWorld();
  const normal = user('1');
  const policies: (abstract new () => unknown)[] = [];

  before(() => w.open());
  after(() => w.close());
  afterEach(async () => {
    await w.reset();
    for (const p of policies.splice(0)) DI.uncache(p as never);
  });

  const pool: ResourceFilter = { op: 'relation', relation: 'pool' };
  const CLIENTS = 'clients';

  // DI keys classes by name, so a same-named policy of a later case would resolve to this one.
  let seq = 0;
  function poolPolicy(): abstract new () => OrmScopePolicy {
    class ClientPolicy extends OrmScopePolicy {
      scope(q: IWhereBuilder<ModelBase>): void {
        q.whereIn('type', [1, 2]);
      }
    }
    Object.defineProperty(ClientPolicy, 'name', { value: `ClientPolicy_${++seq}` });
    policies.push(ClientPolicy);
    return ClientPolicy;
  }

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !w.pg) this.skip();
      });

      describe('Rbac', () => {
        it('should add statement on read:own permission', async () => {
          const Res = await w.resource(dialect);
          await w.db.insertRaw(Res, { id: 'a', UserId: normal.id, Value: 'mine' });
          await w.db.insertRaw(Res, { id: 'b', UserId: 'someone-else', Value: 'theirs' });
          await w.grant({ [w.P.read]: permit(ownerRelation) });

          const result: any = await as(normal, () => Res.where('id', '>', '').first());
          const { expression, bindings } = (await as(normal, () => Res.where('id', '>', '').toDB())) as { expression: string; bindings: unknown[] };

          expect(result).to.be.not.null;
          expect(result.Value).to.equal('mine');
          expect(expression).to.match(/UserId/i);
          expect(bindings).to.include(normal.id);
        });

        it('should throw forbidden when user has no permission', async () => {
          const Res = await w.resource(dialect);
          await w.db.insertRaw(Res, { id: 'a', UserId: normal.id, Value: 'mine' });
          await w.grant({});

          // Changed expectation (B01): a 403 AccessDenied, not the 2.x 'User does not have permission' message.
          const e = await as(normal, () => Res.where('id', '>', '').first()).then(
            () => undefined,
            (x: unknown) => x,
          );
          expect(e).to.be.instanceOf(AccessDenied).and.instanceOf(Forbidden);
          expect((e as AccessDenied).decision.permission).to.equal(w.P.read);
          expect((e as AccessDenied).decision.reason?.code).to.equal('no_access');
        });

        it('should skip rbac check when SkipModelPermissionCheck is set', async () => {
          const Res = await w.resource(dialect);
          await w.db.insertRaw(Res, { id: 'a', UserId: normal.id, Value: 'mine' });
          await w.grant({});

          // Changed expectation (B09, B21): runAs(SYSTEM) or @Unscoped(reason) replaces the storage flag.
          const asSys: any = await asSystem(() => Res.where('id', '>', '').first());
          const unscoped: any = await authzStorage().run({ Principal: normal, Unscoped: 'report' }, async () => Res.where('id', '>', '').first());

          expect(asSys).to.be.not.null;
          expect(asSys.Value).to.equal('mine');
          expect(unscoped).to.be.not.null;
          expect(unscoped.Value).to.equal('mine');
        });
      });

      describe('Rbac relationScope join', () => {
        async function world(dialect: Dialect) {
          const Scope = (await w.db.define({ name: 'Scope', columns: { id: 'INTEGER', code: 'TEXT' } }, dialect)) as Static;
          const Client = (await w.db.define(
            {
              name: 'Client',
              columns: { id: 'INTEGER', type: 'INTEGER', scope_id: 'INTEGER', Name: 'TEXT' },
              decorate: (cls, proto) => {
                AccessResource(CLIENTS, { relationScope: 'join' })(cls);
                OrmScope(cls as never, 'pool')(poolPolicy() as never);
                BelongsTo(Scope as never, 'scope_id', 'id')(proto, 'Scope');
              },
            },
            dialect,
          )) as Static;
          const Campaign = (await w.db.define(
            {
              name: 'Campaign',
              columns: { id: 'INTEGER', client_id: 'INTEGER', agency_id: 'INTEGER' },
              decorate: (_cls, proto) => {
                BelongsTo(Client as never, 'client_id', 'id')(proto, 'Client');
                BelongsTo(Client as never, 'agency_id', 'id')(proto, 'Agency');
              },
            },
            dialect,
          )) as Static;
          (w.db.orm as unknown as { wireRelations(): void }).wireRelations();
          await w.grant({ [`${CLIENTS}:read`]: permit(pool) }, [CLIENTS]);
          return { Scope, Client, Campaign };
        }

        const sqlOf = async (p: Principal, build: () => any) => ((await as(p, () => build().toDB())) as { expression: string }).expression;

        const typeIn = /[`"]\$authz_s\d+\$[`"]\.[`"]type[`"] IN \(\?,\?\)/;
        const joinOnOr = /ON .*[`"]\$authz_s\d+\$[`"]\.[`"]type[`"] IN \(\?,\?\).* AND \( [`"]\$Client\$[`"]\.[`"]Name[`"] = \? OR [`"]\$Client\$[`"]\.[`"]Name[`"] = \? \)/;
        // The parent's own WHERE is the last one: the scope subquery in the JOIN ON has a WHERE of its own.
        const parentWhere = (expression: string) => expression.slice(expression.lastIndexOf(' WHERE '));

        it('should emit rbac constraint in relation JOIN ON clause, not in parent WHERE', async () => {
          const { Campaign } = await world(dialect);

          const expression = await sqlOf(normal, () => Campaign.where('id', '>', 0).populate('Client'));

          // Changed expectation (B15, B20): an @OrmScope relation compiles to an EXISTS keyed on the
          // primary key, so the 2.x direct `$Client$.type IN (?,?)` is the same predicate inside it.
          expect(expression).to.match(/LEFT JOIN .*client_.* ON .*EXISTS \(SELECT 1 FROM .*WHERE /);
          expect(expression.slice(0, expression.lastIndexOf(' WHERE '))).to.match(typeIn);
          const where = parentWhere(expression);
          expect(where).to.not.contain('type');
          expect(where).to.not.contain('authz');
        });

        it('should still filter in WHERE on a root query', async () => {
          const { Client } = await world(dialect);

          const expression = await sqlOf(normal, () => Client.where('id', '>', 0));

          expect(expression).to.not.contain('JOIN');
          expect(parentWhere(expression)).to.match(typeIn);
        });

        it('should combine rbac constraint with user whereOnJoin OR group in JOIN ON clause', async () => {
          const { Campaign } = await world(dialect);

          const expression = await sqlOf(normal, () =>
            Campaign.where('id', '>', 0).populate('Client', function (this: any) {
              this.whereOnJoin(function (this: any) {
                this.where(function (this: any) {
                  this.where('Name', 'Orange').orWhere('Name', 'T-Mobile');
                });
              });
            }),
          );

          // the rbac constraint AND the user OR group both land in the JOIN ON clause, OR group kept whole
          expect(expression).to.match(joinOnOr);

          // parent WHERE stays clean of relation conditions
          const where = parentWhere(expression);
          expect(where).to.not.contain('type');
          expect(where).to.not.contain('Name');
        });

        it('should give each join a distinct alias when one model is joined twice', async () => {
          const { Campaign } = await world(dialect);

          // Two relations to the same client, each filtering the client by its scope (a JOIN to
          // scope). Both scope joins default to the same `$Scope$` alias, which the database
          // rejects with "Not unique table/alias".
          const expression = await sqlOf(normal, () =>
            Campaign.where('id', '>', 0)
              .populate('Client', function (this: any) {
                this.innerJoin('Scope', function (this: any) {
                  this.whereIn('code', ['primespot']);
                });
              })
              .populate('Agency', function (this: any) {
                this.innerJoin('Scope', function (this: any) {
                  this.whereIn('code', ['primespot']);
                });
              }),
          );

          const aliases = [...expression.matchAll(/as [`"]([^`"]+)[`"]/g)].map((m) => m[1]);
          const duplicated = aliases.filter((a, i) => aliases.indexOf(a) !== i);

          expect(duplicated, `duplicate alias in:\n${expression}`).to.be.empty;
        });

        it('should not drop a parent whose relation is filtered by a joined table', async () => {
          const { Campaign, Scope, Client } = await world(dialect);
          // Client 1 sits in the 'yourscreen' scope; the relation filter allows only 'primespot'.
          // The campaign must still come back (with Client empty) - a relation constraint may not
          // decide which parent rows survive. An INNER JOIN in the relation drops the parent.
          await w.db.insertRaw(Scope, { id: 1, code: 'primespot' });
          await w.db.insertRaw(Scope, { id: 2, code: 'yourscreen' });
          await w.db.insertRaw(Client, { id: 1, type: 1, scope_id: 2 });
          await w.db.insertRaw(Campaign, { id: 1, client_id: 1 });

          const campaigns: any[] = await as(normal, () =>
            Campaign.where('id', '>', 0).populate('Client', function (this: any) {
              this.innerJoin('Scope', function (this: any) {
                this.whereIn('code', ['primespot']);
              });
            }),
          );

          expect(campaigns.length).to.equal(1);
          expect(campaigns[0].Client?.Value).to.satisfy((v: unknown) => v === null || v === undefined);
        });

        it('should not drop campaigns whose client type is filtered out', async () => {
          const { Campaign, Client } = await world(dialect);
          // end-to-end: campaign with disallowed client type must stay in results with Client = null
          await w.db.insertRaw(Client, { id: 1, type: 1 });
          await w.db.insertRaw(Client, { id: 2, type: 3 });
          await w.db.insertRaw(Campaign, { id: 1, client_id: 1 });
          await w.db.insertRaw(Campaign, { id: 2, client_id: 2 });

          const campaigns: any[] = await as(normal, () => Campaign.where('id', '>', 0).populate('Client'));

          // both campaigns visible - LEFT JOIN stays a LEFT JOIN
          expect(campaigns.length).to.equal(2);

          const allowed = campaigns.find((c) => c.id === 1);
          const filtered = campaigns.find((c) => c.id === 2);

          // allowed client type populated, disallowed comes back empty
          expect(allowed?.Client?.Value?.id).to.equal(1);
          expect(filtered?.Client?.Value).to.satisfy((v: unknown) => v === null || v === undefined);
        });
      });
    });
  }
});
