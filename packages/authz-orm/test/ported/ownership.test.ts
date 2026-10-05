import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, RelationResolver } from '@spinajs/authz';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { OrmResourceAdapter } from '../../src/adapter.js';
import { ownsRow } from '../../src/relations.js';
import { asSystem } from '../support/system.js';
import { DIALECTS, PortedWorld, as, ownerRelation, permit, user } from './harness.js';

const expect = chai.expect;

// Ported from users legacy-v2/ownership.test.ts (B15, B20): the 2.x `checkOwnership` and
// `ensureOwnership` model helpers are the `owner` relation resolver and the owner residual.
describe('Model ownership helpers', function () {
  this.timeout(60000);
  const w = new PortedWorld();
  const owner = user('42');

  before(() => w.open());
  after(() => w.close());
  afterEach(() => w.reset());

  const ownerResolver = (type: string): RelationResolver => {
    const r = new OrmResourceAdapter().relations().find((x) => x.type === type && x.relation === 'owner');
    if (!r) throw new Error(`no owner resolver for ${type}`);
    return r;
  };

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !w.pg) this.skip();
      });

      async function seed() {
        const Res = await w.resource(dialect);
        await w.db.insertRaw(Res, { id: 'owned', UserId: owner.id, Value: 'owned' });
        await w.db.insertRaw(Res, { id: 'foreign', UserId: String(Number(owner.id) + 999), Value: 'foreign' });
        const row = (id: string) => asSystem(() => (Res as any).where('id', id).first()) as Promise<ModelBase>;
        return { Res, owned: await row('owned'), foreign: await row('foreign') };
      }

      const ref = (id: string) => ({ type: w.TYPE, id });

      it('checkOwnership(primaryKey) returns true for an owned resource', async () => {
        await seed();
        expect(await ownerResolver(w.TYPE).holds(owner, ref('owned'))).to.equal(true);
      });

      it('checkOwnership(primaryKey) returns false for a resource owned by someone else', async () => {
        await seed();
        expect(await ownerResolver(w.TYPE).holds(owner, ref('foreign'))).to.equal(false);
      });

      it('checkOwnership(model) returns true when the model instance is owned', async () => {
        const { owned } = await seed();
        expect(await ownerResolver(w.TYPE).holds(owner, ref('owned'), owned)).to.equal(true);
        expect(ownsRow(owner, owned as never)).to.equal(true);
      });

      it('checkOwnership(model) returns false when the model instance is not owned', async () => {
        const { foreign } = await seed();
        expect(await ownerResolver(w.TYPE).holds(owner, ref('foreign'), foreign)).to.equal(false);
        expect(ownsRow(owner, foreign as never)).to.equal(false);
      });

      it('ensureOwnership restricts a query to rows owned by the user', async () => {
        const { Res } = await seed();
        await w.grant({ [w.P.read]: permit(ownerRelation) });

        const rows = (await as(owner, () => Res.query())) as unknown as { UserId: string }[];

        expect(rows).to.be.an('array').with.length(1);
        expect(rows[0]!.UserId).to.eq(owner.id);
      });

      it('throws when the model has no @ResourceOwner() field', async () => {
        const Plain = await w.db.define({ name: 'Plain', columns: { Value: 'TEXT' }, decorate: (cls) => AccessResource('plain')(cls) }, dialect);
        await w.db.insertRaw(Plain, { id: 'p1', Value: 'x' });
        await w.grant({ 'plain:read': permit(ownerRelation) }, ['plain']);

        let error: unknown;
        try {
          await as(owner, () => (Plain as any).query());
        } catch (e) {
          error = e;
        }
        expect(error, 'an owner grant on a model with no @Owner fails loud').to.be.instanceOf(AuthzConfigError);
        expect((error as Error).message).to.match(/needs @Owner\(\) or an @OrmScope/);
      });
    });
  }
});
