import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { FromDbModel } from '../src/index.js';
import { Test } from './models/Test.js';
import { Test5 } from './models/Test5.js';
import './migrations/Test_2022_06_28_01_13_00.js';
// registers FromModelOverrideController with Controllers whenever this package's HttpServer
// harness (orm-http.test.ts) resolves `test/controllers` - not exercised over HTTP here, see
// the header comment below.
import './controllers/FromModelOverride.js';

/**
 * `@FromModel({ model })` model-override resolution.
 *
 * The task brief for this test asked to copy the harness of `from-model-key.test.ts`: same
 * server bootstrap, same `test/models` fixtures, same `test/controllers` registration,
 * exercised through `req().get(...)` against a controller with two routes (added here as
 * `FromModelOverrideController` in `test/controllers/FromModelOverride.ts`).
 *
 * That harness does not actually exist as described: `from-model-key.test.ts` itself never
 * boots a server - it drives `_extractValue` off a bare prototype instance
 * (`Object.create(FromDbModel.prototype)`), with no DI and no HTTP server. The one file that
 * DOES boot a real `HttpServer` is `orm-http.test.ts`, and only one file in this package may
 * do that: mocha loads every `test/**\/*.test.ts` into a single process, `filters.test.ts`'s
 * `after()` calls `DI.clearCache()`, and a second `HttpServer`/`fsService` bootstrap running
 * later in that same process reproduces the exact "before all hook" TypeError
 * (`Cannot read properties of undefined (reading 'defaultProvider')`) that already breaks
 * `orm-http.test.ts` when the full suite runs - confirmed on a clean checkout, before any
 * change from this task. `dto-relation-resolve.test.ts` hits the same constraint and
 * resolves it the same way this file does: skip HttpServer / Controllers / fsService,
 * bootstrap the Orm only, and call the production code path directly.
 *
 * So this test drives `FromDbModel.extract()` directly - the exact method `@FromModel`
 * wires up via `Route(Parameter('FromDbModel', ...))` in src/index.ts - against a real
 * sqlite-backed Orm and the two model classes from the brief (`Test`, `Test5`).
 * `FromModelOverrideController` still exists as the production-representative registration
 * (and Task 4 depends on the same `model` option), it is just not the path this file
 * asserts through.
 *
 * The `Configuration` implementation is its OWN class (`FromModelOverrideTestConfiguration`),
 * not the shared `TestConfiguration` from `common.ts`: `@spinajs/di` resolves a single
 * (non-array) type to the LAST *distinct* class ever registered for that abstract token
 * (`container.ts`'s `getCurrentType`), and re-registering the exact same `TestConfiguration`
 * class a second time is a no-op dedup - it does not move it back to the end of that list.
 * `filters.test.ts` registers its own `FilterTestConfiguration` (`Migration.OnStartup: false`)
 * as `Configuration` earlier in the same mocha process; reusing `TestConfiguration` here would
 * silently resolve to THAT config instead, and `Orm` would skip migrations against a
 * `test` table that was never created ("no such table: test"). A distinct class name sorts
 * this file's config last again, deterministically.
 */
class FromModelOverrideTestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: {
        targets: [{ name: 'Empty', type: 'ConsoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { Table: 'orm_migrations', OnStartup: true },
          },
        ],
      },
    };
  }
}

describe('FromDbModel model override (@FromModel({ model }))', function () {
  this.timeout(15000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(FromModelOverrideTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Orm); // runs migrations, seeds `test` table (Id 1 = 'witaj')
  });

  const req = (params: Record<string, unknown>) => ({ params, query: {}, headers: {}, body: null }) as any;

  it('resolves through the reflected parameter type by default', async () => {
    const fromDbModel = await DI.resolve(FromDbModel);
    const param = { Index: 0, Name: 'id', Options: {}, RuntimeType: Test } as any;

    const result = await fromDbModel.extract({ Payload: {} } as any, [], param, req({ id: '1' }));

    expect((result.Args as any).constructor.name).to.equal('Test');
  });

  it('resolves through the model override when options.model is set', async () => {
    const fromDbModel = await DI.resolve(FromDbModel);
    const param = { Index: 0, Name: 'id', Options: { model: () => Test5 }, RuntimeType: Test } as any;

    const result = await fromDbModel.extract({ Payload: {} } as any, [], param, req({ id: '1' }));

    expect((result.Args as any).constructor.name).to.equal('Test5');
  });
});
