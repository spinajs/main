import { DI } from '@spinajs/di';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm, OrmMigrationGuard, OrmMigrator } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { AuthorizationModel, AuthzService, SYSTEM, authz } from '@spinajs/authz';
import { ListStaticModel, testHost } from '@spinajs/authz-testing';
import { DbConfig, resetSystemPrincipal } from '@spinajs/configuration-db-source';
import { expect } from 'chai';
import 'mocha';

import { TestConfiguration, req, seed, testConfig } from './common.js';
import { startApp, stopApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';
import { ConfigurationController } from '../src/controllers/Configuration.js';
import '../src/bootstrap.js';

const JSON_HEADERS = { Accept: 'application/json' };

const message = (res: ChaiHttp.Response) => (res.body as { error: { message: string } }).error.message;

const stored = (slug: string) => authz().runAs(SYSTEM, 'test', () => DbConfig.where('Slug', slug).first());

describe('PATCH /configuration/:slug refuses a value of another JSON type than the entry', function () {
  this.timeout(25000);

  let unregisterSource: () => void;
  const adminModel = testHost.named(
    'config-admin',
    testHost.instance(
      new ListStaticModel({
        name: 'config-admin',
        votes: (r) => (r.principal.id === 'admin' && r.permission.startsWith('configuration:') ? { permitWhen: { op: 'true' } } : {}),
        capabilities: { fields: true },
        lists: { 'configuration:read': { kind: 'all' } },
      }),
    ),
  );

  before(async () => {
    // uploads.test.ts leaves its own Configuration registered, and it and the root AuthzService cached
    DI.unregister(TestConfiguration);
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    unregisterSource = registerHeaderSource();
    // Registered and listed in authz.models before the boot: the root service reads its models list once.
    DI.register(adminModel).as(AuthorizationModel);

    const config = testConfig();
    await startApp({
      controllers: [ConfigurationController],
      config: { ...config, authz: { ...(config.authz as object), models: ['config-admin'] } },
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
    DI.unregister(AuthorizationModel, adminModel);
    unregisterSource();
    resetSystemPrincipal();
  });

  beforeEach(async () => {
    await migrateTestDatabase();
    await authz().runAs(SYSTEM, 'test', async () => {
      await DbConfig.truncate();
      await seed();
      // no Meta bounds, so a converted value is not refused by a bound by chance
      await DbConfig.insert([
        { Slug: 'tune.count', Group: 'tune', Type: 'number', Value: '10', Default: '10', Exposed: 1, Watch: 1 },
        { Slug: 'tune.rate', Group: 'tune', Type: 'float', Value: '0.5', Default: '0.5', Exposed: 1, Watch: 1 },
        { Slug: 'app.paging', Group: 'app', Type: 'json', Value: '{}', Default: '{}', Exposed: 1, Watch: 1 },
        { Slug: 'app.export', Group: 'app', Type: 'json', Value: '{}', Default: '{}', Exposed: 1, Watch: 1 },
      ]);
    });
  });

  for (const [slug, value, type] of [
    ['tune.count', 10, 'integer'],
    ['tune.rate', 0.5, 'number'],
  ] as const) {
    for (const sent of [true, null, '1e1', '0x15']) {
      it(`answers 400 to ${JSON.stringify(sent)} on ${slug}, and the row still reads back as a number`, async () => {
        const res = await req().patch(`configuration/${slug}`).set(JSON_HEADERS).send({ Value: sent });
        expect(res).to.have.status(400);
        expect(message(res)).to.equal(`Value must be ${type}`);

        expect((await stored(slug)).Value).to.equal(value);
      });
    }

    it(`stores a JSON number on ${slug} and reads it back as a number`, async () => {
      const res = await req().patch(`configuration/${slug}`).set(JSON_HEADERS).send({ Value: 21 });
      expect(res).to.have.status(200);

      expect((await stored(slug)).Value).to.equal(21);
    });
  }

  it('answers 400 to a Default that is not a JSON number', async () => {
    const res = await req().patch('configuration/tune.count').set(JSON_HEADERS).send({ Value: 11, Default: '0x15' });
    expect(res).to.have.status(400);
    expect(message(res)).to.equal('Default must be integer');

    const entry = await stored('tune.count');
    expect(entry.Value).to.equal(10);
    expect(entry.Default).to.equal(10);
  });

  for (const sent of [1, 'true', '1', null]) {
    it(`answers 400 to ${JSON.stringify(sent)} on a boolean entry`, async () => {
      const res = await req().patch('configuration/app.debug').set(JSON_HEADERS).send({ Value: sent });
      expect(res).to.have.status(400);
      expect(message(res)).to.equal('Value must be boolean');

      expect((await stored('app.debug')).Value).to.equal(false);
    });
  }

  it('stores a JSON boolean on a boolean entry', async () => {
    const res = await req().patch('configuration/app.debug').set(JSON_HEADERS).send({ Value: true });
    expect(res).to.have.status(200);

    expect((await stored('app.debug')).Value).to.equal(true);
  });

  it('answers 400 to a number on a string entry', async () => {
    const res = await req().patch('configuration/mail.from').set(JSON_HEADERS).send({ Value: 5 });
    expect(res).to.have.status(400);
    expect(message(res)).to.equal('Value must be string');
  });

  it('answers 400 to a property the registered schema would convert, naming its path', async () => {
    const res = await req()
      .patch('configuration/app.limits')
      .set(JSON_HEADERS)
      .send({ Value: { perPage: '50' } });
    expect(res).to.have.status(400);
    expect(message(res)).to.equal('Value/perPage must be integer');

    expect((await stored('app.limits')).Value).to.deep.equal({ perPage: 20 });
  });

  it('still stores the defaults the registered schema adds', async () => {
    const res = await req()
      .patch('configuration/app.paging')
      .set(JSON_HEADERS)
      .send({ Value: { sort: 'name' } });
    expect(res).to.have.status(200);

    expect((await stored('app.paging')).Value).to.deep.equal({ sort: 'name', perPage: 20 });
  });

  it('answers 400 to manyOf items that are not strings, naming the item', async () => {
    const res = await req().patch('configuration/app.features').set(JSON_HEADERS).send({ Value: [1, 2] });
    expect(res).to.have.status(400);
    expect(message(res)).to.contain('Value/0 must be string');

    expect((await stored('app.features')).Value).to.deep.equal(['a', 'b']);
  });

  it('stores null where a slug schema allows it in a later anyOf branch', async () => {
    const res = await req()
      .patch('configuration/app.export')
      .set(JSON_HEADERS)
      .send({ Value: { limit: null } });
    expect(res).to.have.status(200);

    expect((await stored('app.export')).Value).to.deep.equal({ limit: null });
  });

  it('stores a string where a slug schema allows it in a later anyOf branch', async () => {
    const res = await req()
      .patch('configuration/app.export')
      .set(JSON_HEADERS)
      .send({ Value: { label: '5' } });
    expect(res).to.have.status(200);

    expect((await stored('app.export')).Value).to.deep.equal({ label: '5' });
  });

  it('answers 400 to a value no anyOf branch of the slug schema takes as sent', async () => {
    const res = await req()
      .patch('configuration/app.export')
      .set(JSON_HEADERS)
      .send({ Value: { limit: '5' } });
    expect(res).to.have.status(400);

    expect((await stored('app.export')).Value).to.deep.equal({});
  });
});
