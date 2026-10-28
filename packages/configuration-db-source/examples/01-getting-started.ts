/**
 * Getting started — load configuration from a database table.
 *
 * Importing `@spinajs/configuration-db-source` auto-registers:
 *   - a Bootstrapper that persists exposed options and starts the watch timer,
 *   - a ConfigurationSource (Order 999, so it loads AFTER file sources) that
 *     reads the `configuration` table and merges every row into the config,
 *   - the `DbConfig` model and the migration that creates the table.
 *
 * The db source reuses connection options that an earlier source (eg. a config
 * file) already produced under `db.Connections`, so those must be available
 * before the db source runs.
 *
 * Run (after building the workspace):
 *   node lib/examples/01-getting-started.js
 */
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, StaticConfigurationSource } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

// side-effect import: registers the bootstrapper, source, model & migration
import '@spinajs/configuration-db-source';

// FrameworkConfiguration.onLoad() is merged after every source ran, too late for the
// db source; a source with an Order below 999 provides the connection in time.
const AppConfigSource = StaticConfigurationSource(
  {
    // which connection / table the db source should read from
    configuration_db_source: {
      connection: 'default', // 'default' resolves to db.DefaultConnection
      table: 'configuration',
    },
    db: {
      DefaultConnection: 'sqlite',
      Connections: [
        {
          Driver: 'orm-driver-sqlite',
          Name: 'sqlite',
          Filename: './db.sqlite',
          // create the `configuration` table on startup
          Migration: { OnStartup: true },
        },
      ],
    },
  },
  0,
);

async function main() {
  DI.register(FrameworkConfiguration).as(Configuration);
  DI.register(AppConfigSource).as(ConfigurationSource);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

  // run framework bootstrappers (db source registers its DI hooks here)
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }

    // loading the configuration runs every source, including the db source
  const cfg = await DI.resolve(Configuration);

  // resolving the ORM runs the migration that creates the `configuration` table
  await DI.resolve(Orm);

  // any row in the `configuration` table is now readable by its Slug
  console.log('app.title =', cfg.get('app.title', '<unset>'));
}

void main();
