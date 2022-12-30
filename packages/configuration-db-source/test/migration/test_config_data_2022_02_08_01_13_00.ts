/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Migration('sqlite')
export class configuration_db_source_2022_02_08_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // await connection.schema().createTable('configuration', (table) => {
    //   table.int('Id').primaryKey().autoIncrement();
    //   table.string('Slug', 64).notNull();
    //   table.text('Value');
    //   table.string('Group', 32);
    //   table.enum('Type', ['int', 'float', 'string', 'json', 'date', 'datetime', 'time', 'boolean']);
    // });

    // await connection.index().unique().table('configuration').name('configuration_unique_slug').columns(['Slug']);

    await connection
      .insert()
      .values({
        Slug: 'config1',
        Value: 'text-value-1',
        Group: 'db-conf',
        Type: 'string',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config2',
        Value: 1,
        Group: 'db-conf',
        Type: 'int',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config3',
        Value: 10.4,
        Group: 'db-conf',
        Type: 'float',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config4',
        Value: JSON.stringify({ hello: 'world' }),
        Group: 'db-conf',
        Type: 'json',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config5',
        Value: DateTime.now().toFormat('dd-MM-YYYY'),
        Group: 'db-conf',
        Type: 'date',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config6',
        Value: DateTime.now().toFormat('HH:mm:ss'),
        Group: 'db-conf',
        Type: 'time',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config7',
        Value: DateTime.now().toISO(),
        Group: 'db-conf',
        Type: 'datetime',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config8',
        Value: false,
        Group: 'db-conf',
        Type: 'boolean',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config9',
        Value: DateTime.now().toFormat('dd-MM-yyyy') + ';' + DateTime.now().toFormat('dd-MM-yyyy'),
        Group: 'db-conf',
        Type: 'date-range',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config10',
        Value: DateTime.now().toFormat('HH:mm:ss') + ';' + DateTime.now().toFormat('HH:mm:ss'),
        Group: 'db-conf',
        Type: 'time-range',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config11',
        Value: DateTime.now().toISO() + ';' + DateTime.now().toISO(),
        Group: 'db-conf',
        Type: 'datetime-range',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config12',
        Value: 'hello',
        Group: 'db-conf',
        Meta: JSON.stringify({
          oneOf: ['hello', 'world'],
        }),
        Type: 'oneOf',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config12',
        Value: 'hello2',
        Group: 'db-conf',
        Meta: JSON.stringify({
          oneOf: ['hello', 'hello2', 'hello3'],
        }),
        Type: 'manyOf',
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config13',
        Value: 1,
        Group: 'db-conf',
        Meta: JSON.stringify({
          min: 0,
          max: 2,
        }),
        Type: 'range',
      })
      .into('configuration');
  }

  // tslint:disable-next-line: no-empty
  public async down(_connection: OrmDriver): Promise<void> {
    //_connection.schema().dropTable('configuration');
  }
}
