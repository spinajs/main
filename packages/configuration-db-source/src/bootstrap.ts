/* eslint-disable @typescript-eslint/require-await */
import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { DbConfigurationModel } from './models/DbConfigurationModel';
import CONFIGURATION_SCHEMA from './schemas/configuration.db.source.schema';
import { IConfigEntryOptions } from './types';
import { Configuration, IConfigEntryOptions as IConfigEntryOptionsCommon } from '@spinajs/configuration-common';
import { InsertBehaviour } from '@spinajs/orm';
import _ from 'lodash';

/**
 * watch interval, default 5 min
 */
const CONFIG_WATCH_TIMER_INTERVAL = 5 * 60 * 1000;

@Injectable(Bootstrapper)
export class DbConfigSourceBotstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');

    DI.once('di.resolved.Orm', (container: IContainer) => {
      const vars = container
        .get<{ path: string; options: IConfigEntryOptions & IConfigEntryOptionsCommon }[]>('__configuration_property__')
        .filter((x) => x.options)
        .filter((x) => x.options.expose);

      /**
       * Insert to db all exposed config options
       */
      for (const v of vars) {
        if (v.options.expose) {
          void DbConfigurationModel.insert(
            {
              Slug: v.path,
              Value: v.options.defaultValue,
              Group: v.options.exposeOptions.group,
              Label: v.options.exposeOptions.label,
              Description: v.options.exposeOptions.description,
              Meta: v.options.exposeOptions.meta,
              Required: v.options.required,
              Type: v.options.exposeOptions.type,
            },
            InsertBehaviour.InsertOrIgnore,
          );
        }
      }

      const watchTimer = setInterval(() => {
        const varsToWatch = vars.filter((x) => x.options.exposeOptions.watch);
        const cService = container.get(Configuration);

        void DbConfigurationModel.query()
          .whereIn(
            'Slug',
            varsToWatch.map((x) => x.path),
          )
          .then((result: unknown) => {
            (result as DbConfigurationModel[]).forEach((r) => {
              const cfgVal = cService.get(r.Slug);
              if (!_.isEqual(cfgVal, r.Value)) {
                cService.set(r.Slug, r.Value);
              }
            });

            return;
          });
      }, CONFIG_WATCH_TIMER_INTERVAL);

      DI.once('di.dispose', () => {
        clearInterval(watchTimer);
      });
    });
    return;
  }
}
