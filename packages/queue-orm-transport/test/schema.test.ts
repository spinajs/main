import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Orm, OrmMigrator } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { OrmEventTransportInitial_2022_06_28_01_13_00 } from '../src/migrations/OrmEventTransportInitial_2022_06_28_01_13_00.js';
import { Event } from '../src/models/Event.js';
import { Subscriber } from '../src/models/Subscriber.js';

class SchemaConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      db: {
        DefaultConnection: 'orm-event-transport',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'orm-event-transport',
            Migration: { Table: 'orm_migrations', OnStartup: true },
          },
        ],
      },
    };
  }
}

describe('event transport schema', () => {
  before(async () => {
    void OrmEventTransportInitial_2022_06_28_01_13_00;
    DI.setESMModuleSupport();
    DI.register(SchemaConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(Configuration);
    await DI.resolve(OrmMigrator);
  });

  const driver = () => DI.get(Orm)!.Connections.get('orm-event-transport')!;

  it('inserts an Event and a Subscriber through their models', async () => {
    const e = new Event({ Type: 'user.created', Value: { id: 1 } });
    await e.insert();
    const s = new Subscriber({ Name: 'worker' });
    await s.insert();

    expect(Subscriber.getModelDescriptor().PrimaryKey).to.deep.eq(['Id']);
    expect((await Event.where('Id', e.Id).first()).Type).to.eq('user.created');
    expect((await Subscriber.where('Name', 'worker').first()).Id).to.eq(s.Id);
  });

  it('leaves FinishedAt empty on a new job', async () => {
    await driver().insert().into('orm_event_transport__job').values({ Type: 'j', Value: '{}' });
    const job = (await driver().select().from('orm_event_transport__job').first()) as { FinishedAt: unknown };
    expect(job.FinishedAt).to.be.null;
  });

  it('down() drops every table up() created', async () => {
    await new OrmEventTransportInitial_2022_06_28_01_13_00().down(driver());
    for (const table of ['orm_event_transport__event', 'orm_event_transport__subscribers', 'orm_event_transport__queue', 'orm_event_transport__job']) {
      expect(await driver().tableInfo(table), table).to.be.null;
    }
  });
});
