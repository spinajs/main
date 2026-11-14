import 'mocha';
import { expect } from 'chai';
import '@spinajs/orm-sqlite';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { Intl } from '@spinajs/intl';
import { httpApp, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, Idempotent, Ok, Post, RouteRegistrationException } from '../src/index.js';
// No `import '@spinajs/idempotency'` here, on purpose: the gate's import() is the first time the package loads, after the Orm resolved.

@BasePath('idem-orm')
class IdemOrmController extends BaseController {
  @Post()
  @Idempotent()
  public create() {
    return new Ok();
  }
}

class IdemOrmConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.db = {
      DefaultConnection: 'sqlite',
      Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } }],
    };
    this.Config.idempotency = { store: 'OrmIdempotencyStore', lease: '30s', sweepBatch: 500, sweepEvery: '5m' };
  }
}

describe('@Idempotent on OrmIdempotencyStore without the app-entry import', function () {
  this.timeout(30_000);

  it('refuses the route when the Orm resolved before @spinajs/idempotency was imported', async () => {
    // Orm first: it reads its models now, and IdempotencyKeyModel is not among them
    const app = await httpApp({ configuration: IdemOrmConfiguration, register: (c) => c.register(IdemOrmController).as(BaseController), resolve: [Orm, Intl] });
    try {
      const err = await app.resolve(Controllers).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).to.be.instanceOf(RouteRegistrationException);
      expect((err as Error).message).to.include("import '@spinajs/idempotency'");
    } finally {
      await app.dispose();
    }
  });
});
