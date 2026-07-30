import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as path from 'node:path';
import * as sinon from 'sinon';
import { Orm } from '../src/index.js';
import { ConnectionConf, FakeMysqlDriver, bootstrapAll, registerFakes, stubDb } from './misc.js';
import '../src/bootstrap.js';
import '@spinajs/log';

const expect = chai.expect;

const FIXTURES = path.resolve(path.join(process.cwd(), 'test', 'mocks', 'migration-pipeline'));

const ALWAYS = 'Pipeline_Always_2026_07_29_10_00_00';
const ONLY_LOCAL = 'Pipeline_OnlyLocal_2026_07_29_10_01_00';

/**
 * Points `system.dirs.migrations` at a real fixture directory on disk holding one unsuffixed and
 * one `.local`-suffixed migration - the seam none of the other migration-environment suites
 * exercise: `migration-env.test.ts` substitutes a `FakeMigrationSource` and never touches
 * `system.dirs.migrations`, and `migration-sources.test.ts` never reaches a full `Orm`. This proves
 * the whole pipeline together: a real `.local.ts` file on disk is applied under `APP_ENV=local` and
 * entirely absent - not merely unapplied, absent from `status()` too - under `APP_ENV=prod`.
 */
class PipelineConf extends ConnectionConf {
  public static Env = 'prod';

  public async resolve(): Promise<void> {
    await super.resolve();

    this.set('system.dirs.migrations', [FIXTURES]);
    this.set('process.env.APP_ENV', PipelineConf.Env);
  }
}

/**
 * `FilesystemMigrationSource` loads fixture files via `DI.__spinajs_require__`, which needs ESM
 * mode switched on to import a `.ts` fixture directly - the same setup `migration-sources.test.ts`
 * uses. `DI.clearCache()` first because `setESMModuleSupport()`'s registration lives in the
 * container cache and would otherwise survive from a previous test only by accident.
 */
async function resolveOrm(): Promise<Orm> {
  DI.clearCache();
  DI.setESMModuleSupport();
  return await DI.resolve(Orm);
}

describe('Orm migration pipeline - a real .local.ts file on disk, end to end', () => {
  before(() => {
    registerFakes();
    // `ConnectionConf` also declares a mysql connection ( see misc.ts )
    DI.register(FakeMysqlDriver).as('mysql');
    DI.register(PipelineConf).as(Configuration);
  });

  after(() => {
    DI.unregister(PipelineConf);
    DI.unregister(FakeMysqlDriver);

    // the fixtures' own @Migration decorators register into the ROOT container the moment the
    // filesystem source imports them, and that registration outlives this file
    const registered = (DI.getRegisteredTypes('__migrations__') ?? []) as Array<{ name: string }>;
    for (const type of registered) {
      if (type.name === ALWAYS || type.name === ONLY_LOCAL) {
        DI.unregister(type as any);
      }
    }
  });

  beforeEach(async () => {
    DI.removeAllListeners('di.resolve.Configuration');
    await bootstrapAll();
    // no tracking rows anywhere - both migrations are pending, so status() has something to say
    // about the one that is expected to be entirely absent, not merely unapplied
    stubDb([]);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('applies both the unsuffixed and the .local-suffixed migration under APP_ENV=local', async () => {
    PipelineConf.Env = 'local';

    const orm = await resolveOrm();

    expect(orm.Migrations.map((m) => m.name)).to.include(ALWAYS);
    expect(orm.Migrations.map((m) => m.name)).to.include(ONLY_LOCAL);

    const status = await orm.Migration.status();
    expect(status.map((s) => s.name)).to.include(ALWAYS);
    expect(status.map((s) => s.name)).to.include(ONLY_LOCAL);
  });

  it('applies only the unsuffixed migration under APP_ENV=prod - the .local one is absent from status() entirely', async () => {
    PipelineConf.Env = 'prod';

    const orm = await resolveOrm();

    expect(orm.Migrations.map((m) => m.name)).to.include(ALWAYS);
    expect(orm.Migrations.map((m) => m.name), 'a .local migration must never be registered under prod').to.not.include(ONLY_LOCAL);

    const status = await orm.Migration.status();
    expect(status.map((s) => s.name)).to.include(ALWAYS);
    expect(status.map((s) => s.name), 'a .local migration must be absent from status(), not merely unapplied').to.not.include(ONLY_LOCAL);
  });
});
