/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Migration('sqlite')
export class test_config_data_2022_02_08_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection
      .insert()
      .values({
        Slug: 'config1',
        Value: 'text-value-1',
        Group: 'db-conf',
        Type: 'string',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config2',
        Value: 1,
        Group: 'db-conf',
        Type: 'int',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config3',
        Value: 10.4,
        Group: 'db-conf',
        Type: 'float',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config4',
        Value: JSON.stringify({ hello: 'world' }),
        Group: 'db-conf',
        Type: 'json',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config5',
        Value: DateTime.now().toFormat('dd-MM-yyyy'),
        Group: 'db-conf',
        Type: 'date',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config6',
        Value: DateTime.now().toFormat('HH:mm:ss'),
        Group: 'db-conf',
        Type: 'time',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config7',
        Value: DateTime.now().toISO(),
        Group: 'db-conf',
        Type: 'datetime',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config8',
        Value: false,
        Group: 'db-conf',
        Type: 'boolean',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config9',
        Value: DateTime.now().toFormat('dd-MM-yyyy') + ';' + DateTime.now().toFormat('dd-MM-yyyy'),
        Group: 'db-conf',
        Type: 'date-range',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config10',
        Value: DateTime.now().toFormat('HH:mm:ss') + ';' + DateTime.now().toFormat('HH:mm:ss'),
        Group: 'db-conf',
        Type: 'time-range',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config11',
        Value: DateTime.now().toISO() + ';' + DateTime.now().toISO(),
        Group: 'db-conf',
        Type: 'datetime-range',
        Exposed: true,
        Watch: false,
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
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config13',
        Value: '["hello2","hello3"]',
        Group: 'db-conf',
        Meta: JSON.stringify({
          oneOf: ['hello', 'hello2', 'hello3'],
        }),
        Type: 'manyOf',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');

    await connection
      .insert()
      .values({
        Slug: 'config14',
        Value: 1,
        Group: 'db-conf',
        Meta: JSON.stringify({
          min: 0,
          max: 2,
        }),
        Type: 'range',
        Exposed: true,
        Watch: false,
      })
      .into('configuration');
  }

  // tslint:disable-next-line: no-empty
  public async down(_connection: OrmDriver): Promise<void> {
    //_connection.schema().dropTable('configuration');
  }
}
