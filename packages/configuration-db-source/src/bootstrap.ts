/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/require-await */
import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { DbConfig, isConfigValueEqual } from './models/DbConfig.js';
import CONFIGURATION_SCHEMA from './schemas/configuration.db.source.schema.js';
import { Configuration, IConfigEntryOptions, IConfigEntryOptions as IConfigEntryOptionsCommon } from '@spinajs/configuration-common';
import { InsertBehaviour, Orm } from '@spinajs/orm';
import { InternalLogger } from '@spinajs/internal-logger';

/**
 * watch interval, default 3 min
 */
const CONFIG_WATCH_TIMER_INTERVAL = 3 * 60 * 1000;

const LOG_CHANNEL = 'configuration-db-source';

type __dbCOnfigOptions = { path: string; options: IConfigEntryOptions & IConfigEntryOptionsCommon };

/**
 * Persists (or ignores, if it already exists) an exposed config option in the db.
 *
 * Returns the insert promise so callers can await it - eg. before reading the
 * row back - instead of firing it and racing the read.
 */
async function __saveConfigOptions(v: __dbCOnfigOptions): Promise<void> {
  if (!v.options.expose) {
    return;
  }

  const value = v.options.exposeOptions?.type === 'json' ? JSON.stringify(v.options.defaultValue) : v.options.defaultValue;

  await DbConfig.insert(
    {
      Slug: v.path,
      Value: value,
      Group: v.options.exposeOptions?.group,
      Label: v.options.exposeOptions?.label,
      Description: v.options.exposeOptions?.description,
      Meta: v.options.exposeOptions?.meta,
      Required: v.options.required,
      Type: v.options.exposeOptions?.type,
      Watch: v.options.exposeOptions?.watch ?? false,
      Default: value ?? undefined,
      Exposed: true,
    },
    InsertBehaviour.InsertOrIgnore,
  );
}

/**
 * Persists an exposed option and then loads its current db value into the live
 * configuration.
 *
 * Save and read are sequenced (await save -> read) so the read always observes
 * the inserted row - reading right after a fire-and-forget insert could miss it.
 */
async function __syncConfigOption(v: __dbCOnfigOptions): Promise<void> {
  try {
    await __saveConfigOptions(v);

    const stored = await DbConfig.where('Slug', v.path).first();
    DI.get(Configuration)!.set(v.path, stored?.Value ?? v.options.defaultValue);
  } catch (err) {
    InternalLogger.error(`Failed to sync exposed config option '${v.path}' with db: ${err instanceof Error ? err.message : String(err)}`, LOG_CHANNEL);
  }
}

@Injectable(Bootstrapper)
export class DbConfigSourceBotstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');

    // persist & load exposed options as they get registered (eg. lazily resolved services).
    // before ORM is resolved there is no connection - those vars are handled by the
    // di.resolved.Orm handler below, so skip them here to avoid failing db calls.
    DI.on('di.registered.__configuration_property__', (v: __dbCOnfigOptions) => {
      if (!v.options || !v.options.expose || !DI.has(Orm)) {
        return;
      }

      void __syncConfigOption(v);
    });

    // register vals added before orm is resolved eg. at bootstrap phase
    DI.once('di.resolved.Orm', (container: IContainer) => {
      const vars = container
        .get<__dbCOnfigOptions>(Array.ofType('__configuration_property__'))!
        .filter((x) => x.options)
        .filter((x) => x.options.expose);

      // insert all exposed config options (InsertOrIgnore - safe to repeat)
      void Promise.all(vars.map((v) => __saveConfigOptions(v))).catch((err) => {
        InternalLogger.error(`Failed to persist exposed config options to db: ${err instanceof Error ? err.message : String(err)}`, LOG_CHANNEL);
      });

      this.startWatchTimer(container, vars);
    });

    return;
  }

  /**
   * Periodically reloads watched config values from the db and pushes changes
   * into the live configuration.
   *
   * Runs are chained one-after-another (the next run is scheduled only once the
   * previous one settles) so a slow or stuck query can never overlap / pile up,
   * and any db error is logged instead of becoming an unhandled rejection.
   */
  private startWatchTimer(container: IContainer, vars: __dbCOnfigOptions[]): void {
    const varsToWatch = vars.filter((x) => x.options.exposeOptions?.watch);

    // nothing to watch - don't arm a timer at all
    if (varsToWatch.length === 0) {
      return;
    }

    const cService = container.get(Configuration)!;
    const watchedSlugs = varsToWatch.map((x) => x.path);
    const interval = DI.get<{ value: number }>('__config_watch_interval__');
    const intervalMs = interval?.value || CONFIG_WATCH_TIMER_INTERVAL;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleNext = () => {
      if (disposed) {
        return;
      }
      timer = setTimeout(() => void run(), intervalMs);
    };

    const run = async () => {
      try {
        const result = (await DbConfig.query().whereIn('Slug', watchedSlugs)) as DbConfig[];
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

    scheduleNext();

    DI.once('di.dispose', () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
    });
  }
}
