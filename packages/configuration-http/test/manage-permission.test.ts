import { DI } from '@spinajs/di';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm, OrmMigrationGuard, OrmMigrator } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { AuthorizationModel, AuthzService, SYSTEM, authz } from '@spinajs/authz';
import { ListStaticModel, testHost } from '@spinajs/authz-testing';
import { DbConfig, resetSystemPrincipal } from '@spinajs/configuration-db-source';
import { expect } from 'chai';
import 'mocha';

import { req, seed, testConfig } from './common.js';
import { startApp, stopApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';
import { ConfigurationController } from '../src/controllers/Configuration.js';
import '../src/bootstrap.js';

const JSON_HEADERS = { Accept: 'application/json' };

const stored = (slug: string) => authz().runAs(SYSTEM, 'test', () => DbConfig.where('Slug', slug).first());

describe('PATCH /configuration/:slug needs configuration:manage to change Default or Watch', function () {
  this.timeout(25000);

  let unregisterSource: () => void;
  const model = testHost.named(
    'config-manage',
    testHost.instance(
      new ListStaticModel({
        name: 'config-manage',
        votes: (r) => {
          if (r.principal.id === 'admin' && r.permission.startsWith('configuration:')) return { permitWhen: { op: 'true' } };
          if (r.principal.id === 'operator' && (r.permission === 'configuration:read' || r.permission === 'configuration:update')) return { permitWhen: { op: 'true' } };
          if (r.principal.id === 'valueOnly' && r.permission === 'configuration:read') return { permitWhen: { op: 'true' } };
          if (r.principal.id === 'valueOnly' && r.permission === 'configuration:update') return { permitWhen: { op: 'true' }, fields: { write: ['Value'] } };
          return {};
        },
        capabilities: { fields: true },
        lists: { 'configuration:read': { kind: 'all' } },
      }),
    ),
  );

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    unregisterSource = registerHeaderSource();
    // Registered and listed in authz.models before the boot: the root service reads its models list once.
    DI.register(model).as(AuthorizationModel);

    const config = testConfig();
    await startApp({
      controllers: [ConfigurationController],
      config: { ...config, authz: { ...(config.authz as object), models: ['config-manage'] } },
      skip: ['DbConfigSourceBotstrapper'],
    });
    await DI.resolve(AuthzService);
  });

  after(async () => {
    await DI.get(Orm)?.dispose();
    DI.uncache(Orm);
    DI.uncache(OrmMigrator);
    DI.uncache(OrmMigrationGuard);
    await stopApp();
    DI.unregister(AuthorizationModel, model);
    unregisterSource();
    resetSystemPrincipal();
  });

  beforeEach(async () => {
    await migrateTestDatabase();
    await authz().runAs(SYSTEM, 'test', async () => {
      await DbConfig.truncate();
      await seed();
    });
  });

  it('answers 403 to a Default from a caller without configuration:manage, and keeps the row', async () => {
    const res = await req('operator').patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 20, Default: 7 });
    expect(res).to.have.status(403);

    const entry = await stored('app.maxUsers');
    expect(entry.Value).to.equal(10);
    expect(entry.Default).to.equal(5);
  });

  it('answers 403 to a Watch from a caller without configuration:manage, and keeps the row', async () => {
    const res = await req('operator').patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 20, Watch: false });
    expect(res).to.have.status(403);

    const entry = await stored('app.maxUsers');
    expect(entry.Value).to.equal(10);
    expect(Boolean(entry.Watch)).to.equal(true);
  });

  it('answers 403 before validating a Default the caller may not change', async () => {
    const res = await req('operator').patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 20, Default: 999 });
    expect(res).to.have.status(403);
  });

  it('still lets a caller without configuration:manage change Value alone', async () => {
    const res = await req('operator').patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 20 });
    expect(res).to.have.status(200);

    const entry = await stored('app.maxUsers');
    expect(entry.Value).to.equal(20);
    expect(entry.Default).to.equal(5);
    expect(Boolean(entry.Watch)).to.equal(true);
  });

  it('needs no configuration:manage for a Watch the update grant strips', async () => {
    const res = await req('valueOnly').patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 20, Watch: false });
    expect(res).to.have.status(200);

    const entry = await stored('app.maxUsers');
    expect(entry.Value).to.equal(20);
    expect(Boolean(entry.Watch)).to.equal(true);
  });

  it('stores Default and Watch for a caller holding configuration:manage', async () => {
    const res = await req('admin').patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 20, Default: 7, Watch: false });
    expect(res).to.have.status(200);

    const entry = await stored('app.maxUsers');
    expect(entry.Value).to.equal(20);
    expect(entry.Default).to.equal(7);
    expect(Boolean(entry.Watch)).to.equal(false);
  });
});
