import { DI } from '@spinajs/di';
import { SYSTEM, authz } from '@spinajs/authz';
import { hostHarness, runBehaviour } from '@spinajs/authz-testing';
import { DbConfig, resetSystemPrincipal } from '@spinajs/configuration-db-source';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import '@spinajs/log';

import { ConfigurationHttpBootstrapper } from '../src/bootstrap.js';
import configurationHttpConfig from '../src/config/configuration-http.js';

// B20.configuration: DbConfig scoped by the ORM guard (design §14.1). B09.configuration runs in configuration-db-source.
runBehaviour(
  ['B20.configuration'],
  () =>
    hostHarness({
      facets: ['orm', 'configuration'],
      async register(host) {
        host.setConfig(['authz', 'orm', 'domain'], host.domain);
        for (const [name, def] of Object.entries(configurationHttpConfig.authz.permissions))
          host.setConfig(['authz', 'domains', host.domain, 'permissions', name], def);
      },
      async extend(host) {
        host.setConfig(['logger'], {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        });
        host.setConfig(['db'], {
          DefaultConnection: 'sqlite',
          Connections: [
            { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { OnStartup: true } },
          ],
        });
        DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
        const orm = await DI.resolve(Orm);

        new ConfigurationHttpBootstrapper().bootstrap();
        await authz(host.domain).runAs(SYSTEM, 'test', async () => {
          for (const r of host.world.lane?.configuration?.rows ?? [])
            await DbConfig.insert({
              Slug: r.path,
              Value: r.value,
              Group: 'test',
              Type: 'string',
              Watch: false,
              Exposed: true,
            });
        });

        return {
          lane: {
            orm: {
              async run(q) {
                if (q.op !== 'select') throw new Error('B20.configuration only selects');
                const rows = await DbConfig.query();
                return { ids: rows.map((r) => String(r.Id)), count: rows.length, sql: [] };
              },
              rows: async () => [],
            },
          },
          async dispose() {
            orm.dispose();
            DI.uncache(Orm);
            DI.uncache('orm-driver-sqlite');
            DI.unregister(SqliteOrmDriver);
            resetSystemPrincipal();
          },
        };
      },
    }),
  { strict: true },
);
