import { DI } from '@spinajs/di';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm, OrmMigrationGuard, OrmMigrator } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { AuthorizationModel, AuthzService, SYSTEM, authz } from '@spinajs/authz';
import { ListStaticModel, testHost } from '@spinajs/authz-testing';
import { DbConfig, resetSystemPrincipal } from '@spinajs/configuration-db-source';
import { DataValidator } from '@spinajs/validation';
import { expect } from 'chai';
import 'mocha';

import { req, seed, testConfig } from './common.js';
import { startApp, stopApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';
import { ConfigurationController } from '../src/controllers/Configuration.js';
import '../src/bootstrap.js';

const JSON_HEADERS = { Accept: 'application/json' };

const REFUSALS: [string, string, object, string][] = [
  ['a value above Meta max', 'app.maxUsers', { Value: 999 }, 'Value must be <= 100'],
  ['a value below Meta min', 'app.maxUsers', { Value: 0 }, 'Value must be >= 1'],
  ['a value off its type', 'app.maxUsers', { Value: 'abc' }, 'Value must be integer'],
  ['a value outside oneOf', 'app.theme', { Value: 'blue' }, 'Value must be equal to one of the allowed values'],
  ['a value off its format', 'app.startDate', { Value: 'not a date' }, 'Value must match format "date"'],
  ['a value breaking the slug schema', 'app.limits', { Value: { perPage: 0 } }, 'Value/perPage must be >= 1'],
  ['a value missing a property of the slug schema', 'app.limits', { Value: { export: true } }, "Value must have required property 'perPage'"],
  ['a body without Value', 'app.maxUsers', {}, 'Value is required'],
  ['a Watch that is no boolean', 'app.maxUsers', { Value: 20, Watch: 'sometimes' }, 'Watch must be boolean'],
  ['a body that is no object', 'app.maxUsers', [20], 'Value is required'],
];

function describeRefusals(title: string, config: Record<string, unknown>) {
  describe(title, function () {
    this.timeout(25000);

    let unregisterSource: () => void;
    const model = testHost.named(
      'config-one-error-body',
      testHost.instance(
        new ListStaticModel({
          name: 'config-one-error-body',
          votes: (r) => (r.principal.id === 'admin' && r.permission.startsWith('configuration:') ? { permitWhen: { op: 'true' } } : {}),
          lists: { 'configuration:read': { kind: 'all' } },
        }),
      ),
    );

    before(async () => {
      DI.setESMModuleSupport();
      DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
      unregisterSource = registerHeaderSource();
      DI.register(model).as(AuthorizationModel);
      // The validator reads `validation.messages` once, when it is resolved.
      DI.uncache(DataValidator);

      const base = testConfig();
      await startApp({
        controllers: [ConfigurationController],
        config: { ...base, authz: { ...(base.authz as object), models: ['config-one-error-body'] }, ...config },
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
      DI.uncache(DataValidator);
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

    for (const [what, slug, body, message] of REFUSALS) {
      it(`answers ${what} with { error: { message } } naming the broken constraint`, async () => {
        const res = await req('admin').patch(`configuration/${slug}`).set(JSON_HEADERS).send(body);
        expect(res).to.have.status(400);
        expect(res.body).to.deep.equal({ error: { message } });
      });
    }
  });
}

describeRefusals('PATCH /configuration/:slug answers one error body, with validation.messages off', {});
describeRefusals('PATCH /configuration/:slug answers one error body, with validation.messages on', { 'validation.messages': true });
