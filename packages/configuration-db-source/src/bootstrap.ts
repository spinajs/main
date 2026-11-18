/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/require-await */
import { Autoinject, Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { registerConfigurationSchema } from '@spinajs/configuration';
import { DbConfig, isConfigValueEqual } from './models/DbConfig.js';
import { DbConfigValueConverter } from './converter.js';
import CONFIGURATION_SCHEMA from './schemas/configuration.db.source.schema.js';
import { Configuration, IConfigEntryOptions, IConfigEntryOptions as IConfigEntryOptionsCommon } from '@spinajs/configuration-common';
import { extractModelDescriptor, InsertBehaviour, Orm } from '@spinajs/orm';
import { InternalLogger } from '@spinajs/internal-logger';
import { normalizeFileEntryOptions } from './file.js';
import { asSystem } from './system.js';
import { DbConfigWatcher, isWatchCurrent, isWatchDisposed, startWatch, watchToken } from './watcher.js';

/**
 * watch interval, default 3 min
 */
const CONFIG_WATCH_TIMER_INTERVAL = 3 * 60 * 1000;

const LOG_CHANNEL = 'configuration-db-source';

/**
 * Emitted on the root DI container as `(slug, previous, next)` after the watch poll changed a configuration value;
 * `next` is what the configuration holds after the change. Listeners are not awaited.
 */
export const CONFIGURATION_DB_CHANGED_EVENT = 'configuration.db.changed';

type __dbCOnfigOptions = { path: string; options: IConfigEntryOptions & IConfigEntryOptionsCommon };

/** A `configuration` row as the driver returns it: `Value` is the stored text, not yet converted for its `Type`. */
type StoredConfigRow = { Slug: string; Type: string; Value: unknown; Watch: unknown; Exposed: unknown };

@Injectable(Bootstrapper)
export class DbConfigSourceBotstrapper extends Bootstrapper {
  @Autoinject(DbConfigValueConverter)
  protected Converter!: DbConfigValueConverter;

  /** Per watched row, the stored type and text last refused and why; cleared once the row applies. */
  private refusedRows = new Map<string, { type: string; value: unknown; cause: string }>();

  private configuration: Configuration | null = null;

  /** The watcher that runs the timer, and the container it was resolved in. */
  private watcher: DbConfigWatcher | null = null;
  private watcherContainer: IContainer | null = null;

  /** Set once the exposed options were swept into the `configuration` table; late registrations sync one by one after it. */
  private tableReady = false;

  /** The authz domain whose service runs the queries as SYSTEM; the one holding the `configuration` model. */
  public authzDomain = 'root';

  /** What the last `bootstrap()` registered on DI; removed on `di.dispose` and by the next `bootstrap()`. */
  private listeners: Array<[string, (...args: unknown[]) => void]> = [];

  /** The table check and sweep the last signal started; never rejects. */
  private lastSignal: Promise<void> = Promise.resolve();

  /** The inserts of the sweep in progress or done; a later signal waits for them instead of sweeping again. */
  private sweep: Promise<void> = Promise.resolve();

  public async bootstrap(): Promise<void> {
    registerConfigurationSchema(CONFIGURATION_SCHEMA);
    this.unbind();
    this.tableReady = false;
    this.sweep = Promise.resolve();
    // a watcher disposed by hand stays cached and never starts again: a new bootstrap() watches with a fresh one. The
    // cache keys it by its own class, which is a subclass when an application registered one .as(DbConfigWatcher).
    if (this.watcher && isWatchDisposed(this.watcher)) {
      // a container that no longer holds its watcher was disposed itself: look in the root again
      if (this.watcherContainer?.isCached(this.watcher)) {
        this.watcherContainer.uncache(this.watcher.constructor);
      } else {
        this.watcherContainer = null;
      }
      this.watcher = null;
    }
    this.lastSignal = Promise.resolve();

    // persist & load exposed options as they get registered (eg. lazily resolved services).
    // Until the configuration table is ready those vars are handled by the sweep in
    // syncExposedOptions(), so skip them here to avoid failing db calls.
    this.listen('di.registered.__configuration_property__', (arg: unknown) => {
      const v = arg as __dbCOnfigOptions;
      if (!v.options || !v.options.expose) {
        return;
      }

      // synchronous, so a misdeclared file entry throws out of the registration itself
      normalizeFileEntryOptions(v.path, v.options.exposeOptions);

      if (!this.tableReady) {
        return;
      }

      void this.syncConfigOption(v);
    });

    // The Orm resolves once its migrations are applied, so the table exists then unless the connection's Migration.Check
    // is 'warn' or 'off'. A migration tool's Orm resolves before it migrates; its OrmMigrator signals orm.migrated after.
    const onOrm = (container: unknown, orm: unknown) => {
      this.lastSignal = this.sweepIfTableExists(container as IContainer, orm as Orm);
    };
    this.listen('di.resolved.Orm', onOrm);
    this.listen('orm.migrated', onOrm);

    this.listen('di.dispose', () => this.unbind());

    // a cached Orm never signals again, so a bootstrap() in a running application sweeps and starts the watch now
    const container = this.watcherContainer ?? DI.RootContainer;
    const orm = container.get(Orm);
    if (orm) {
      onOrm(container, orm);
    }
  }

  /** Removes the DI listeners `bootstrap()` added. */
  public unbind(): void {
    for (const [event, listener] of this.listeners) {
      DI.off(event, listener);
    }

    this.listeners = [];
  }

  /**
   * Settles once the exposed options a resolved Orm or a finished migration run swept are written to the table, or the
   * sweep failed and was logged. Resolves at once when no such signal came since `bootstrap()`.
   */
  public whenSwept(): Promise<void> {
    return this.lastSignal;
  }

  private listen(event: string, listener: (...args: unknown[]) => void): void {
    DI.on(event, listener);
    this.listeners.push([event, listener]);
  }

  private async tableExists(orm: Orm): Promise<boolean> {
    const descriptor = extractModelDescriptor(DbConfig)!;
    const driver = orm.Connections.get(descriptor.Connection!);

    if (!driver) {
      return false;
    }

    return await driver.schema().tableExists(descriptor.TableName);
  }

  private async sweepIfTableExists(container: IContainer, orm: Orm): Promise<void> {
    if (this.tableReady) {
      return this.sweep;
    }

    try {
      if (await this.tableExists(orm)) {
        await this.syncExposedOptions(container);
      }
    } catch (err) {
      InternalLogger.error({ error: err }, 'Failed to check the configuration table', LOG_CHANNEL);
    }
  }

  /** Persists every exposed option registered so far and starts the watch timer; once per process. */
  private async syncExposedOptions(container: IContainer): Promise<void> {
    if (this.tableReady) {
      return this.sweep;
    }

    this.tableReady = true;

    const vars = container
      .get<__dbCOnfigOptions>(Array.ofType('__configuration_property__'))!
      .filter((x) => x.options)
      .filter((x) => x.options.expose);

    vars.forEach((v) => normalizeFileEntryOptions(v.path, v.options.exposeOptions));

    // insert all exposed config options (InsertOrIgnore - safe to repeat)
    const inserted = Promise.all(vars.map((v) => this.saveConfigOptions(v)));
    this.sweep = (async () => {
      try {
        await inserted;
      } catch (err) {
        InternalLogger.error({ error: err }, 'Failed to persist exposed config options to db', LOG_CHANNEL);

        // a sweep into a table that is not there must not send every late registration to it; the next signal sweeps again
        const orm = container.get(Orm);
        this.tableReady = orm ? await this.tableExists(orm).catch(() => false) : false;
      }
    })();

    this.startWatchTimer(container);

    return this.sweep;
  }

  /**
   * Persists (or ignores, if it already exists) an exposed config option in the db.
   *
   * Returns the insert promise so callers can await it - eg. before reading the
   * row back - instead of firing it and racing the read.
   */
  private async saveConfigOptions(v: __dbCOnfigOptions): Promise<void> {
    if (!v.options.expose) {
      return;
    }

    const type = v.options.exposeOptions?.type;

    // serialize the default value to its canonical stored form using the same
    // converter the model/source use, keyed off the declared `Type`.
    // toDB() is typed `any` upstream (IValueConverter) - `unknown` is the honest
    // narrowing since the concrete shape depends on `type` and isn't known here.
    const value = this.Converter.toDB(v.options.defaultValue, { Type: type } as any, undefined as any, { TypeColumn: 'Type' }) as unknown;

    await asSystem(
      () =>
        DbConfig.insert(
          {
            Slug: v.path,
            Value: value,
            Group: v.options.exposeOptions?.group,
            Label: v.options.exposeOptions?.label,
            Description: v.options.exposeOptions?.description,
            Meta: v.options.exposeOptions?.meta,
            Required: v.options.required,
            Type: type,
            Watch: v.options.exposeOptions?.watch ?? false,
            Default: value ?? undefined,
            Exposed: true,
          },
          InsertBehaviour.InsertOrIgnore,
        ),
      this.authzDomain,
    );

    await this.syncMetadata(v);
  }

  /**
   * InsertOrIgnore leaves rows from an earlier release untouched, so label / group / meta edits in
   * code would never reach them. Rewrites the declared columns; `Value`, `Default` and `Watch` are
   * written only by the insert, so an administrator's change to them lasts.
   */
  private async syncMetadata(v: __dbCOnfigOptions): Promise<void> {
    const o = v.options.exposeOptions;
    // `Type` is a NOT NULL column: an untyped declaration has nothing valid to write there.
    if (!o?.type) {
      return;
    }

    const row = await asSystem(() => DbConfig.where('Slug', v.path).first(), this.authzDomain);
    if (!row) {
      return;
    }

    const upToDate = (row.Group ?? null) === (o.group ?? null) && (row.Label ?? null) === (o.label ?? null) && (row.Description ?? null) === (o.description ?? null) && row.Type === o.type && !!row.Required === !!v.options.required && isConfigValueEqual(row.Meta ?? null, o.meta ?? null);

    if (upToDate) {
      return;
    }

    row.Group = o.group as string;
    row.Label = o.label;
    row.Description = o.description;
    row.Meta = o.meta;
    row.Type = o.type;
    row.Required = !!v.options.required;

    await asSystem(() => row.update(), this.authzDomain);
  }

  /**
   * Persists an exposed option and then loads its current db value into the live
   * configuration.
   *
   * Save and read are sequenced (await save -> read) so the read always observes
   * the inserted row - reading right after a fire-and-forget insert could miss it.
   */
  private async syncConfigOption(v: __dbCOnfigOptions): Promise<void> {
    try {
      await this.saveConfigOptions(v);

      const stored = await asSystem(() => DbConfig.where('Slug', v.path).first(), this.authzDomain);
      // the source skips rows an admin un-exposed, so their value must not reach the config here either
      if (!stored || stored.Exposed) {
        DI.get(Configuration)!.set(v.path, stored?.Value ?? v.options.defaultValue);
      }
    } catch (err) {
      InternalLogger.error({ error: err, path: v.path }, 'Failed to sync exposed config option ${path} with db', LOG_CHANNEL);
    }
  }

  /**
   * One poll: reloads the exposed rows whose `Watch` column is set and pushes changes into the live
   * configuration. The watch timer calls it on every run; db errors are logged, not thrown.
   */
  public async refreshWatched(): Promise<void> {
    const cService = this.configuration ?? DI.get(Configuration)!;
    const watcher = this.watcher ?? (DI.RootContainer.get(Orm) ? this.resolveWatcher(DI.RootContainer) : null);
    const token = watcher ? watchToken(watcher) : 0;

    try {
      // raw, so each row is converted on its own: hydrating the table would let one unreadable Value fail the whole poll
      const rows = await asSystem(() => DbConfig.select().asRaw<StoredConfigRow[]>(), this.authzDomain);
      // filtered in memory, as the source does, to stay driver-agnostic about how booleans are stored
      for (const row of rows.filter((r) => Boolean(r.Watch) && Boolean(r.Exposed))) {
        // checked per row: the watcher may be disposed while the query runs, or by a listener of the change event
        if (watcher && !isWatchCurrent(watcher, token)) {
          break;
        }
        this.applyWatched(cService, row);
      }
    } catch (err) {
      InternalLogger.error({ error: err }, 'Failed to refresh watched config values from db', LOG_CHANNEL);
    }
  }

  /**
   * Writes one polled row into the live configuration. A value that cannot be read as its `Type`, or that the
   * configuration refuses, leaves the old one in place.
   */
  private applyWatched(cService: Configuration, row: StoredConfigRow): void {
    const refused = this.refusedRows.get(row.Slug);
    // Configuration logs every set() it refuses, so a row is tried again only once its stored type or text changed.
    if (refused !== undefined && refused.type === row.Type && refused.value === row.Value) {
      return;
    }

    try {
      const value = this.Converter.fromDB(row.Value, row, { TypeColumn: 'Type' }) as unknown;
      // Slug is the canonical config path (same value passed to @Config).
      // Group is display-only metadata and must not be part of the path.
      const previous = cService.get(row.Slug);
      if (!isConfigValueEqual(previous, value)) {
        cService.set(row.Slug, value);
        // the schemas set() applies may coerce or fill in the value, so listeners get what the application reads
        this.emitWatchedChanged(row.Slug, previous, cService.get(row.Slug));
      }
      this.refusedRows.delete(row.Slug);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      this.refusedRows.set(row.Slug, { type: row.Type, value: row.Value, cause });
      if (refused?.cause === cause) {
        return;
      }

      InternalLogger.error({ error: err, slug: row.Slug }, 'Watched config value ${slug} from db was refused, the previous value stays', LOG_CHANNEL);
    }
  }

  /** A listener that throws is logged: it must neither mark the applied row as refused nor stop the rest of the poll. */
  private emitWatchedChanged(slug: string, previous: unknown, next: unknown): void {
    try {
      DI.emit(CONFIGURATION_DB_CHANGED_EVENT, slug, previous, next);
    } catch (err) {
      InternalLogger.error({ error: err, slug }, 'A listener of configuration.db.changed failed for ${slug}', LOG_CHANNEL);
    }
  }

  /**
   * Starts the watch timer on the watcher of `container`; a sweep after a failed one replaces the running timer. A
   * disposed watcher starts nothing.
   */
  private startWatchTimer(container: IContainer): void {
    const interval = DI.get<{ value: number }>('__config_watch_interval__');
    this.configuration = container.get(Configuration)!;
    startWatch(this.resolveWatcher(container), () => this.refreshWatched(), interval?.value || CONFIG_WATCH_TIMER_INTERVAL);
  }

  /** Resolved only once the Orm is, so the container's reverse-order dispose ends the watcher before the Orm. */
  private resolveWatcher(container: IContainer): DbConfigWatcher {
    this.watcher = container.resolve(DbConfigWatcher);
    this.watcherContainer = container;
    return this.watcher;
  }
}
