import { AsyncService } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { OrmException } from './exceptions.js';
import { OrmMigration } from './interfaces.js';
import { compareMigrationNames, IMigrationPlanEntry, IMigrationUpOptions, MigrationRunner } from './migration-runner.js';
import type { Orm } from './orm.js';

export interface IOrmMigrateOptions extends IMigrationUpOptions {
  /** Apply only this migration, by class name. */
  name?: string;

  /** Apply without running the `data()` seeds; `seed()` runs them later. */
  skipSeed?: boolean;
}

export interface IOrmSeedOptions {
  /** Seed only this applied migration, by class name. */
  name?: string;

  /** Limit the run to one connection, by name or alias. */
  connection?: string;
}

/** The explicit migration engine over one Orm: what the CLI, migrateTestDatabase() and a desktop app's own start-up code call. The Orm never resolves it. */
export class OrmMigrator extends AsyncService {
  @Logger('ORM')
  protected Log: Log;

  /** `up`, `down`, `status` and `resolve` over the Orm's migrations and connections. */
  public Runner: MigrationRunner;

  constructor(public readonly Orm: Orm) {
    super();
    this.Runner = new MigrationRunner(Orm);
  }

  /**
   * Applies the pending migrations, re-reads the table info of the models their statements touched, then runs their
   * `data()`; `fake` records them and seeds nothing. What `migrate-up` runs.
   * All of it holds one migration lock per connection, so a second run waits for the seeds too.
   */
  public async migrate(options: IOrmMigrateOptions = {}): Promise<OrmMigration[]> {
    return await this.Runner.withRunLock(options.connection, async () => {
      const { executed, touched } = await this.Runner.up(options.name, { ...options, locked: true });

      // wireRelations() reads no column info, so the relations wired by the Orm's resolve stay valid
      if (touched.models.length > 0) {
        await this.Orm.reloadTableInfo({ models: touched.models });
      }

      if (!options.fake && !options.skipSeed) {
        await this.Runner.assertRunLocksHeld();
        await this.runDataPhase(executed);
      }

      return executed;
    }, options.name);
  }

  /**
   * Runs `data()` of every applied migration ( or only `name`, or one `connection` ), in run order, under the run lock,
   * and reports the failures together. What `migrate-seed` runs: seeds run again, so they must be safe to rerun.
   */
  public async seed(options: IOrmSeedOptions = {}): Promise<OrmMigration[]> {
    const appliedEntries = async () => (await this.Runner.status({ connection: options.connection, readOnly: true })).filter((e) => e.applied && (!options.name || e.name === options.name));

    // taking the run lock sets up the tracking table, so a database with nothing to seed is left as it is
    if ((await appliedEntries()).length === 0) {
      return this.nothingToSeed(options);
    }

    return await this.Runner.withRunLock(options.connection, async () => {
      const applied = await appliedEntries();

      if (options.name && applied.length === 0) {
        return this.nothingToSeed(options);
      }

      const instances: OrmMigration[] = [];
      for (const e of applied.sort((a, b) => compareMigrationNames(a.name, b.name))) {
        const driver = this.Orm.Connections.get(e.connection)!;
        const type = this.Orm.Migrations.find((m) => m.name === e.name)!.type;
        instances.push(await driver.Container.resolve<OrmMigration>(type, [driver]));
      }

      await this.Runner.assertRunLocksHeld();
      await this.runDataPhase(instances);
      return instances;
    }, options.name);
  }

  /** `[]`, or the reason a `name` has nothing to seed. */
  protected nothingToSeed(options: IOrmSeedOptions): OrmMigration[] {
    if (!options.name) {
      return [];
    }

    if (!this.Orm.Migrations.some((m) => m.name === options.name)) {
      throw new OrmException(`Migration ${options.name} is not registered - check the name for typos`);
    }

    throw new OrmException(`Migration ${options.name} is not applied on ${options.connection ? `connection ${options.connection}` : 'any configured connection'} - nothing to seed`);
  }

  /** What `migrate()` with the same `name` and `connection` would apply, in order, with the batch each would get; applies nothing. */
  public async plan(options: { name?: string; connection?: string } = {}): Promise<IMigrationPlanEntry[]> {
    return await this.Runner.pending(options.name, options.connection);
  }

  /**
   * Runs the `data()` hook of every migration just applied. Every hook runs even when an earlier one throws, and the
   * failures are reported together: the migrations are already recorded as applied, so a rerun would not retry the
   * hooks skipped after the first failure.
   *
   * Known loss: a run in which M1 applies and M2 throws never reaches here, M1 is recorded, and `M1.data()` never
   * runs on any later pass. The tracking table has no "applied but unseeded" state, so `data()` must be safe to rerun
   * by hand ( docs/orm/10-migrations.md ). `migrate-seed --name <M1>` reruns it.
   */
  protected async runDataPhase(executed: OrmMigration[]): Promise<void> {
    const errors: Array<{ name: string; reason: string; error: unknown }> = [];

    for (const m of executed) {
      this.Log.trace({ migration: m.constructor.name }, 'Migrating data function for migration ${migration} ...');

      try {
        await m.data();
      } catch (err) {
        // a hook may reject with a non-Error ( `throw 'boom'` ), whose .message would name no reason
        const reason = err instanceof Error ? err.message : String(err);

        this.Log.error({ error: err, migration: m.constructor.name }, 'Migration ${migration}:data() failed');
        errors.push({ name: m.constructor.name, reason, error: err });
      }
    }

    if (errors.length > 0) {
      throw new OrmException(`Migration data() phase failed for: ${errors.map((e) => `${e.name} (${e.reason})`).join(', ')}`, undefined, undefined, undefined, errors[0].error);
    }
  }
}
