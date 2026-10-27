import { AsyncService, Autoinject, Container } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { OrmException } from './exceptions.js';
import { OrmMigration } from './interfaces.js';
import { IMigrationUpOptions, MigrationRunner } from './migration-runner.js';
import type { Orm } from './orm.js';

/** What `DI.resolve(OrmMigrator, [ ... ])` hands the migrator: a property of the process, not of the deployment. */
export interface IOrmMigratorOptions {
  /**
   * Apply the pending `Migration.OnStartup` migrations when the Orm resolves. Default true. `false` is for a process
   * that operates on the migrations ( `@spinajs/orm-cli` ): resolved before the Orm, it gets `Runner` and `migrate()`
   * without the schema moving on its way in, and the Orm skips its `db.StrictTableCheck` check.
   */
  MigrateOnStartup?: boolean;
}

export interface IOrmMigrateOptions extends IMigrationUpOptions {
  /** Apply only this migration, by class name. */
  name?: string;
}

/**
 * Applies the migrations and their `data()` seeds for the Orm that resolves it. `Orm.resolve()` calls `boot()` before
 * it reads table info; the seeds wait for `di.resolved.Orm`, so a seed can resolve any service that injects the Orm.
 */
export class OrmMigrator extends AsyncService {
  protected Orm: Orm;

  @Autoinject()
  protected Container: Container;

  @Logger('ORM')
  protected Log: Log;

  /** `up`, `down`, `status` and `resolve` over the Orm's migrations and connections. */
  public Runner: MigrationRunner;

  protected Seeded: Promise<void> = Promise.resolve();

  constructor(protected Options: IOrmMigratorOptions = {}) {
    super();
  }

  public get MigrateOnStartup(): boolean {
    return this.Options.MigrateOnStartup !== false;
  }

  /** Settles when the `data()` seeds of the boot ran; rejects with what failed them. */
  public ready(): Promise<void> {
    return this.Seeded;
  }

  /** Applies the pending `Migration.OnStartup` migrations; their seeds run once `orm` is cached. */
  public async boot(orm: Orm): Promise<void> {
    this.Orm = orm;
    this.Runner = new MigrationRunner(orm);
    this.Seeded = Promise.resolve();

    if (!this.MigrateOnStartup) {
      return;
    }

    // force: false honours each connection's OnStartup flag; a run asked for by hand ( migrate() ) does not
    const { executed } = await this.Runner.up(undefined, { force: false });

    this.Seeded = new Promise<void>((resolve, reject) => {
      const listener = (_container: unknown, resolved: unknown) => {
        if (resolved !== orm) {
          return;
        }

        this.Container.off('di.resolved.Orm', listener);
        this.runDataPhase(executed).then(resolve, (err: unknown) => {
          this.Log.error({ error: err }, 'OrmMigrator data() phase failed');
          reject(err);
        });
      };

      this.Container.on('di.resolved.Orm', listener);
    });

    // read through ready(); a failure nobody awaits is logged above
    this.Seeded.catch(() => undefined);
  }

  /**
   * Applies the pending migrations ( `force` defaults to true ), re-reads the table info of the models their
   * statements touched, then runs their `data()`; `fake` records them and seeds nothing. What `migrate-up` runs.
   */
  public async migrate(options: IOrmMigrateOptions = {}): Promise<OrmMigration[]> {
    const { executed, touched } = await this.Runner.up(options.name, options);

    // wireRelations() reads no column info, so the relations wired by the Orm's resolve stay valid
    if (touched.models.length > 0) {
      await this.Orm.reloadTableInfo({ models: touched.models });
    }

    if (!options.fake) {
      await this.runDataPhase(executed);
    }

    return executed;
  }

  /**
   * Runs the `data()` hook of every migration just applied. Every hook runs even when an earlier one throws, and the
   * failures are reported together: the migrations are already recorded as applied, so a rerun would not retry the
   * hooks skipped after the first failure.
   *
   * Known loss: a run in which M1 applies and M2 throws never reaches here, M1 is recorded, and `M1.data()` never
   * runs on any later pass. The tracking table has no "applied but unseeded" state, so `data()` must be safe to rerun
   * by hand ( docs/orm/10-migrations.md ).
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
