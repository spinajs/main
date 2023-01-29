/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/require-await */
import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { DbConfig } from './models/DbConfig.js';
import CONFIGURATION_SCHEMA from './schemas/configuration.db.source.schema.js';
import { Configuration, IConfigEntryOptions, IConfigEntryOptions as IConfigEntryOptionsCommon } from '@spinajs/configuration-common';
import { InsertBehaviour } from '@spinajs/orm';
import _ from 'lodash';

/**
 * watch interval, default 3 min
 */
const CONFIG_WATCH_TIMER_INTERVAL = 3 * 60 * 1000;

type __dbCOnfigOptions = { path: string; options: IConfigEntryOptions & IConfigEntryOptionsCommon };
function __saveCongigOption(v: __dbCOnfigOptions) {
  if (v.options.expose) {
    void DbConfig.insert(
      {
        Slug: v.path,
        Value: v.options.defaultValue,
        Group: v.options.exposeOptions?.group,
        Label: v.options.exposeOptions?.label,
        Description: v.options.exposeOptions?.description,
        Meta: v.options.exposeOptions?.meta,
        Required: v.options.required,
        Type: v.options.exposeOptions?.type,
        Watch: v.options.exposeOptions?.watch || false,
        Exposed: true,
      },
      InsertBehaviour.InsertOrIgnore,
    );
  }
}

@Injectable(Bootstrapper)
export class DbConfigSourceBotstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');

    // register all conf options
    // as we go ( eg. resolved service )
    DI.on('di.registered.__configuration_property__', (v: __dbCOnfigOptions) => {
      if (v.options && v.options.expose) {
        __saveCongigOption(v);
      }
    });

    // register vals added before orm is resolved eg. at bostrap phase
    DI.once('di.resolved.Orm', (container: IContainer) => {
      const vars = container
        .get<__dbCOnfigOptions>(Array.ofType('__configuration_property__'))
        .filter((x) => x.options)
        .filter((x) => x.options.expose);

      /**
       * Insert to db all exposed config options
       */
      for (const v of vars) {
        __saveCongigOption(v);
      }

      const interval = DI.get('__config_watch_interval__');

      const watchTimer = setInterval(() => {
        const varsToWatch = vars.filter((x) => x.options.exposeOptions.watch);
        const cService = container.get(Configuration);

        if (varsToWatch.length === 0) {
          return;
        }

        void DbConfig.query()
          .whereIn(
            'Slug',
            varsToWatch.map((x) => x.path),
          )
          .then((result: unknown) => {
            (result as DbConfig[]).forEach((r) => {
              const cfgVal = cService.get(`${r.Group}.${r.Slug}`);
              if (!_.isEqual(cfgVal, r.Value)) {
                cService.set(`${r.Group}.${r.Slug}`, r.Value);
              }
            });

            return;
          });
      }, (interval as any)?.value || CONFIG_WATCH_TIMER_INTERVAL);

      DI.once('di.dispose', () => {
        clearInterval(watchTimer);
      });
    });
    return;
  }
}
