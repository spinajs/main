import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { AuthorizationModel, AuthzService, ModelListPlan, PermissionDef, Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, Owner } from '../../src/index.js';
import { RelationOwnerTerm } from '../../src/lists/relation-terms.js';
import { RlsPlanSource, RlsSubjectKeys } from '../../src/plan/index.js';
import { generateRls, rlsResources } from '../../src/rls/index.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };

class Keys extends RlsSubjectKeys {
  readonly model = 'fake';
  static calls = 0;
  async keys(_m: AuthorizationModel, p: Principal): Promise<readonly string[]> {
    Keys.calls++;
    return [`user:${p.id}`, 'team:t1#member'];
  }
}

class Source extends RlsPlanSource {
  readonly model = 'fake';
  plan(_m: AuthorizationModel, permission: PermissionDef): ModelListPlan {
    return permission.name === 'note:read' ? { kind: 'terms', permit: [{ op: 'relation.owner', args: { principals: [] } }], deny: [] } : { kind: 'all' };
  }
}

/** The postgres driver sets the spina.* settings of the principal on each transaction and wraps a lone statement in one. */
describe('RLS session settings on Postgres', function () {
  this.timeout(60000);
  const role = `spina_rls_s_${process.pid}`;
  let db: TestDb | undefined;
  let Note: typeof ModelBase;
  let table: string;
  let service: AuthzService;
  const undo: (() => void)[] = [];

  before(async function () {
    if (!(await TestDb.postgresReachable())) return this.skip();
    db = await TestDb.open({ postgres: true });
    Note = await db.define(
      {
        name: 'RlsNote',
        columns: { author_id: 'TEXT' },
        rows: [
          { id: 'n1', author_id: 'alice' },
          { id: 'n2', author_id: 'bob' },
        ],
        decorate: (c, proto) => {
          AccessResource('note', { rls: true })(c);
          Owner()(proto, 'author_id');
        },
      },
      'postgres',
    );
    table = db.table(Note);
    // The authz boot wants @AccessResource models on the authz connection.
    await db.useAuthz('postgres');
    const schema = db.driver('postgres').Options.Database;
    await db.raw(`DROP ROLE IF EXISTS "${role}"`, [], 'postgres');
    await db.raw(`CREATE ROLE "${role}" NOLOGIN`, [], 'postgres');
    await db.raw(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`, [], 'postgres');
    await db.raw(`GRANT SELECT ON "${table}" TO "${role}"`, [], 'postgres');
    const models = [{ name: 'fake', applies: () => true } as unknown as AuthorizationModel];
    const out = await generateRls({ models, permissions: { get: (name) => ({ name }) as PermissionDef }, resources: rlsResources([Note]).map((r) => r.resource), sources: new Map([['fake', new Source()]]), compilers: new Map([['relation.owner', new RelationOwnerTerm()]]), bypassRole: role });
    for (const sql of out.up) await db.raw(sql, [], 'postgres');
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(RlsSubjectKeys, Keys));
    service = await (await testHost.domains()).service('root');
    sinon.stub(service, 'models').returns([{ name: 'fake' } as AuthorizationModel]);
    testHost.config().set(['authz', 'orm', 'rls'], { session: true });
    Keys.calls = 0;
  });

  afterEach(async () => {
    sinon.restore();
    testHost.config().unset(['authz', 'orm', 'rls']);
    for (const fn of undo.splice(0).reverse()) fn();
    DI.RootContainer.uncache(RlsSubjectKeys);
    await testHost.resetRoot();
  });

  after(async () => {
    if (db === undefined) return;
    await db.clear();
    await db.raw(`DROP OWNED BY "${role}"`, [], 'postgres').catch(() => undefined);
    await db.raw(`DROP ROLE IF EXISTS "${role}"`, [], 'postgres').catch(() => undefined);
    await db.close();
  });

  const setting = async (name: string): Promise<unknown> => ((await db!.raw(`SELECT current_setting('${name}', true) AS v`, [], 'postgres')) as { v: unknown }[])[0].v;

  it("sets the principal's subject keys and principals on a statement outside a transaction, for that statement only", async () => {
    expect(await runWithPrincipal(alice, () => setting('spina.subject_keys'))).to.equal('["user:alice","team:t1#member"]');
    expect(await runWithPrincipal(alice, () => setting('spina.principal'))).to.equal('[{"type":"user","id":"alice"}]');
    testHost.config().set(['authz', 'orm', 'rls'], { session: false });
    expect(await setting('spina.subject_keys')).to.be.oneOf(['', null]);
  });

  it('sets them once at the start of a transaction, and the generated policy reads them', async () => {
    const rows = await runWithPrincipal(alice, () =>
      db!.driver('postgres').transaction(async () => {
        await db!.raw(`SET LOCAL ROLE "${role}"`, [], 'postgres');
        return db!.raw(`SELECT id FROM "${table}" ORDER BY id`, [], 'postgres') as Promise<{ id: string }[]>;
      }),
    );
    expect(rows.map((r) => r.id)).to.deep.equal(['n1']);
  });

  it("turns spina.bypass on under SYSTEM, which only the bypass role's policy honours", async () => {
    expect(await runWithPrincipal(SYSTEM, () => setting('spina.bypass'))).to.equal('on');
    const rows = await runWithPrincipal(SYSTEM, () =>
      db!.driver('postgres').transaction(async () => {
        await db!.raw(`SET LOCAL ROLE "${role}"`, [], 'postgres');
        return db!.raw(`SELECT id FROM "${table}" ORDER BY id`, [], 'postgres') as Promise<{ id: string }[]>;
      }),
    );
    expect(rows.map((r) => r.id)).to.deep.equal(['n1', 'n2']);
  });

  it('computes the keys once per request', async () => {
    await runWithPrincipal(alice, async () => {
      await setting('spina.subject_keys');
      await setting('spina.subject_keys');
    });
    expect(Keys.calls).to.equal(1);
  });
});
