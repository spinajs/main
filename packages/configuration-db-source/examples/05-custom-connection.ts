/**
 * Using a dedicated connection / table for configuration.
 *
 * By default the db source reads the `configuration` table on the `default`
 * connection. Point it elsewhere with the `configuration_db_source` config key
 * - useful when configuration lives in its own database, separate from the
 * application data.
 *
 * IMPORTANT: the migration bundled with this package is `@Migration('default')`
 * and always creates a table named `configuration`. If you use a different
 * connection or table name you must provide your own migration that creates the
 * table with the expected columns (as below) on the target connection.
 *
 * CAVEAT: `configuration_db_source.connection` / `.table` only affect the
 * READ/LOAD path (the source merges that table into the configuration). The
 * exposing & watching machinery uses the `DbConfig` model, which is bound to
 * `@Model('configuration')` on `@Connection('default')`. So a custom table is
 * best suited to read-only configuration loaded from an external store; if you
 * also need `expose` / `watch`, keep the default `configuration` table on the
 * default connection.
 *
 * Run:
 *   node lib/mjs/examples/05-custom-connection.js
 */
import { FrameworkConfiguration } from '@spinajs/configuration';
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';
import '@spinajs/configuration-db-source';

export class AppConfig extends FrameworkConfiguration {
  public onLoad(): unknown {
    return {
      configuration_db_source: {
        // read from the 'config-db' connection instead of the default one
        connection: 'config-db',
        // and from a custom table name instead of 'configuration'
        table: 'app_settings',
      },
      db: {
        DefaultConnection: 'app',
        Connections: [
          {
            // main application data
            Driver: 'orm-driver-sqlite',
            Name: 'app',
            Filename: './app.sqlite',
          },
          {
            // dedicated configuration store
            Driver: 'orm-driver-sqlite',
            Name: 'config-db',
            Filename: './config.sqlite',
            Migration: { OnStartup: true },
          },
        ],
      },
    };
  }
}

/**
 * Custom migration that creates the configuration table on the `config-db`
 * connection, under the custom `app_settings` name. The columns mirror the
 * schema the db source / `DbConfig` model expect.
 */
@Migration('config-db')
export class CreateAppSettingsTable extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('app_settings', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Slug', 64).notNull();
      table.text('Value');
      table.text('Default');
      table.boolean('Required').default().value(0);
      table.boolean('Exposed').notNull().default().value(0);
      table.boolean('Watch').notNull().default().value(0);
      table.string('Group', 32);
      table.string('Label', 64);
      table.string('Description', 256);
      table.string('Environment', 32);
      table.text('Meta');
      table.enum('Type', ['number', 'file', 'float', 'string', 'json', 'date', 'datetime', 'time', 'boolean', 'time-range', 'date-range', 'datetime-range', 'range', 'oneOf', 'manyOf']).notNull();
    });

    await connection.index().unique().table('app_settings').name('app_settings_unique_slug').columns(['Slug']);
  }

  public async down(_connection: OrmDriver): Promise<void> {
    // no-op
  }
}
