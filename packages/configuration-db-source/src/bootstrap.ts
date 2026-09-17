/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/require-await */
import { Autoinject, Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { DbConfig, isConfigValueEqual } from './models/DbConfig.js';
import { DbConfigValueConverter } from './converter.js';
import CONFIGURATION_SCHEMA from './schemas/configuration.db.source.schema.js';
import { Configuration, IConfigEntryOptions, IConfigEntryOptions as IConfigEntryOptionsCommon } from '@spinajs/configuration-common';
import { InsertBehaviour, Orm } from '@spinajs/orm';
import { InternalLogger } from '@spinajs/internal-logger';
import { normalizeFileEntryOptions } from './file.js';

/**
 * watch interval, default 3 min
 */
const CONFIG_WATCH_TIMER_INTERVAL = 3 * 60 * 1000;

const LOG_CHANNEL = 'configuration-db-source';

const PERSIST_ATTEMPTS = 5;

/**
 * base delay between persist attempts, doubled on every retry. Override with the
 * `__config_persist_retry_delay__` DI value.
 */
const PERSIST_RETRY_DELAY = 1000;

type __dbCOnfigOptions = { path: string; options: IConfigEntryOptions & IConfigEntryOptionsCommon };

@Injectable(Bootstrapper)
export class DbConfigSourceBotstrapper extends Bootstrapper {
  @Autoinject(DbConfigValueConverter)
  protected Converter!: DbConfigValueConverter;

  // live - late registrations add to it, the watch timer reads it on every run
  private watchedSlugs = new Set<string>();

  private armWatchTimer: (() => void) | null = null;

  // Every write goes through this chain, one at a time. Concurrent InsertOrIgnore into an empty
  // table can deadlock on the unique Slug index ( InnoDB gap locks ), and the losing rows are dropped.
  private persistQueue: Promise<void> = Promise.resolve();

  public async bootstrap(): Promise<void> {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');

    // persist & load exposed options as they get registered (eg. lazily resolved services).
    // before ORM is resolved there is no connection - those vars are handled by the
    // di.resolved.Orm handler below, so skip them here to avoid failing db calls.
    DI.on('di.registered.__configuration_property__', (v: __dbCOnfigOptions) => {
      if (!v.options || !v.options.expose) {
        return;
      }

      // synchronous, so a misdeclared file entry throws out of the registration itself
      normalizeFileEntryOptions(v.path, v.options.exposeOptions);

      if (!DI.has(Orm)) {
        return;
      }

      void this.enqueue(() => this.syncConfigOption(v));
    });

    // register vals added before orm is resolved eg. at bootstrap phase
    DI.once('di.resolved.Orm', (container: IContainer) => {
      const vars = container
        .get<__dbCOnfigOptions>(Array.ofType('__configuration_property__'))!
        .filter((x) => x.options)
        .filter((x) => x.options.expose);

      vars.forEach((v) => normalizeFileEntryOptions(v.path, v.options.exposeOptions));

      // insert all exposed config options (InsertOrIgnore - safe to repeat)
      vars.forEach((v) => {
        void this.enqueue(() => this.persistConfigOption(v));
      });

      vars.filter((x) => x.options.exposeOptions?.watch).forEach((x) => this.watchedSlugs.add(x.path));
      this.startWatchTimer(container);
    });

    return;
  }

  /**
   * Settles once every exposed option registered so far has been written to the db, or given up on.
   */
  public persisted(): Promise<void> {
    return this.persistQueue;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    // tasks never reject - both of them catch and log - so one failure cannot break the chain
    this.persistQueue = this.persistQueue.then(task);
    return this.persistQueue;
  }

  private async persistConfigOption(v: __dbCOnfigOptions): Promise<void> {
    try {
      await this.saveWithRetry(v);
    } catch (err) {
      InternalLogger.error(`Failed to persist exposed config option '${v.path}' to db: ${err instanceof Error ? err.message : String(err)}`, LOG_CHANNEL);
    }
  }

  /**
   * Another process sharing the database ( a worker, a second instance ) can still deadlock with
   * this one, or be mid-migration so the table does not exist yet. Both pass on their own, and
   * the write is idempotent, so any failure is simply retried.
   */
  private async saveWithRetry(v: __dbCOnfigOptions): Promise<void> {
    const delay = DI.get<{ value: number }>('__config_persist_retry_delay__')?.value ?? PERSIST_RETRY_DELAY;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.saveConfigOptions(v);
      } catch (err) {
        if (attempt >= PERSIST_ATTEMPTS) {
          throw err;
        }

        InternalLogger.warn(`Persisting exposed config option '${v.path}' failed ( attempt ${attempt}/${PERSIST_ATTEMPTS} ), retrying: ${err instanceof Error ? err.message : String(err)}`, LOG_CHANNEL);
        await new Promise((resolve) => setTimeout(resolve, delay * 2 ** (attempt - 1)));
      }
    }
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

    await DbConfig.insert(
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
    );

    await this.syncMetadata(v);
  }

  /**
   * InsertOrIgnore leaves rows from an earlier release untouched, so label / group / meta / default
   * edits in code would never reach them. Rewrites the declared columns; `Value` stays whatever an
   * admin set.
   */
  private async syncMetadata(v: __dbCOnfigOptions): Promise<void> {
    const o = v.options.exposeOptions;
    // `Type` is a NOT NULL column: an untyped declaration has nothing valid to write there.
    if (!o?.type) {
      return;
    }

    const row = await DbConfig.where('Slug', v.path).first();
    if (!row) {
      return;
    }

    const upToDate = (row.Group ?? null) === (o.group ?? null) && (row.Label ?? null) === (o.label ?? null) && (row.Description ?? null) === (o.description ?? null) && row.Type === o.type && !!row.Watch === !!o.watch && !!row.Required === !!v.options.required && isConfigValueEqual(row.Meta ?? null, o.meta ?? null) && isConfigValueEqual(row.Default ?? null, v.options.defaultValue ?? null);

    if (upToDate) {
      return;
    }

    row.Group = o.group as string;
    row.Label = o.label;
    row.Description = o.description;
    row.Meta = o.meta;
    row.Type = o.type;
    row.Watch = o.watch ?? false;
    row.Required = !!v.options.required;
    row.Default = v.options.defaultValue;

    await row.update();
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
      await this.saveWithRetry(v);

      const stored = await DbConfig.where('Slug', v.path).first();
      DI.get(Configuration)!.set(v.path, stored?.Value ?? v.options.defaultValue);
    } catch (err) {
      InternalLogger.error(`Failed to sync exposed config option '${v.path}' with db: ${err instanceof Error ? err.message : String(err)}`, LOG_CHANNEL);
    }

    if (v.options.exposeOptions?.watch) {
      this.watchedSlugs.add(v.path);
      this.armWatchTimer?.();
    }
  }

  /**
   * Periodically reloads watched config values from the db and pushes changes
   * into the live configuration.
   *
   * Runs are chained one-after-another (the next run is scheduled only once the
   * previous one settles) so a slow or stuck query can never overlap / pile up,
   * and any db error is logged instead of becoming an unhandled rejection.
   *
   * The timer is armed only once something is watched - here, or later by the first
   * watched late registration (`armWatchTimer`).
   */
  private startWatchTimer(container: IContainer): void {
    const cService = container.get(Configuration)!;
    const interval = DI.get<{ value: number }>('__config_watch_interval__');
    const intervalMs = interval?.value || CONFIG_WATCH_TIMER_INTERVAL;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let armed = false;

    const scheduleNext = () => {
      if (disposed) {
        return;
      }
      timer = setTimeout(() => void run(), intervalMs);
    };

    const arm = () => {
      if (armed || disposed || this.watchedSlugs.size === 0) {
        return;
      }
      armed = true;
      scheduleNext();
    };

    const run = async () => {
      try {
        const result = await DbConfig.select().whereIn('Slug', [...this.watchedSlugs]);
        result.forEach((r) => {
          // Slug is the canonical config path (same value passed to @Config).
          // Group is display-only metadata and must not be part of the path.
          if (!isConfigValueEqual(cService.get(r.Slug), r.Value)) {
            cService.set(r.Slug, r.Value);
          }
        });
      } catch (err) {
        InternalLogger.error(`Failed to refresh watched config values from db: ${err instanceof Error ? err.message : String(err)}`, LOG_CHANNEL);
      } finally {
        scheduleNext();
      }
    };

    this.armWatchTimer = arm;
    arm();

    DI.once('di.dispose', () => {
      disposed = true;
      if (this.armWatchTimer === arm) {
        this.armWatchTimer = null;
      }
      if (timer) {
        clearTimeout(timer);
      }
    });
  }
}
