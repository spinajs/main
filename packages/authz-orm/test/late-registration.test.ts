import * as chai from 'chai';
import 'mocha';

import { AuthorizationModel, AuthzConfigError, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import { ModelBase } from '@spinajs/orm';

import { Owner, registerAccessResource } from '../src/index.js';
import { TestDb } from './support/db.js';

const expect = chai.expect;

const TYPE = 'lateinvoice';
const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const ROWS = [
  { id: 'i1', owner: 'alice' },
  { id: 'i2', owner: 'bob' },
];
const LATE = `resource type "${TYPE}" was registered with adapter "orm" after the domain booted; register it before boot, or boot the domain again`;

type Invoice = typeof ModelBase & { all(): Promise<ModelBase[]> };
const ids = (rows: ModelBase[]) => rows.map((r) => (r as unknown as { id: string }).id).sort();

describe('authz-orm: a resource type registered after the domain booted', function () {
  this.timeout(60000);
  let db: TestDb;
  const undo: (() => void | Promise<void>)[] = [];

  const setConfig = (path: string[], value: unknown) => {
    const config = testHost.config();
    const before = config.get<unknown>(path);
    config.set(path, value);
    undo.push(() => (before === undefined ? config.unset(path) : config.set(path, before)));
  };

  // db.clear() forgets the registration (unregisterResource), so later suites never see the type.
  const defineInvoice = async () =>
    (await db.define({
      name: 'Invoice',
      columns: { owner: 'TEXT' },
      rows: ROWS,
      decorate: (cls, proto) => {
        Owner()(proto, 'owner');
        registerAccessResource(cls as never, TYPE);
      },
    })) as Invoice;

  before(async () => {
    db = await TestDb.open();
    await (await testHost.domains()).service('root');
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    for (const fn of undo.splice(0).reverse()) await fn();
    await db.clear();
  });

  it('a scoped select on the root domain booted before the registration throws AuthzConfigError naming the type', async () => {
    setConfig(['authz', 'orm', 'domain'], 'root');
    const Invoice = await defineInvoice();
    const e = await runWithPrincipal(alice, async () => Invoice.all()).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).to.be.instanceOf(AuthzConfigError);
    expect((e as Error).message).to.equal(`Authz domain "root": ${LATE}`);
  });

  it('a domain booted after the registration serves the type', async () => {
    const Invoice = await defineInvoice();
    const ds = await testHost.domains();
    const name = 'late1';
    const permissions = Object.fromEntries(['read', 'create', 'update', 'delete'].map((a) => [`${TYPE}:${a}`, { types: [TYPE] }]));
    setConfig(['authz', 'domains', name], { permissions, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 } });
    setConfig(['authz', 'orm', 'domain'], name);
    const container: IContainer = ds.create(name, 'root');
    undo.push(() => (ds.names().includes(name) ? container.dispose() : undefined));
    container.register(testHost.instance(new StaticModel({ name: 'm1', votes: { [`${TYPE}:read`]: { permitWhen: { op: 'relation', relation: 'owner' } } } }))).as(AuthorizationModel);
    await ds.service(name);

    expect(ids(await runWithPrincipal(alice, async () => Invoice.all()))).to.deep.equal(['i1']);
  });
});
