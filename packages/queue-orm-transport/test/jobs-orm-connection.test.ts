// import { DI } from '@spinajs/di';
// import chaiAsPromised from 'chai-as-promised';
// import * as chai from 'chai';
// import { expect } from 'chai';
// import { Configuration } from '@spinajs/configuration';

// import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
// import { Orm } from '@spinajs/orm';
// import { join, normalize, resolve } from 'path';
// import { TestConfiguration } from './common';

// chai.use(chaiAsPromised);
// function dir(path: string) {
//   return resolve(normalize(join(process.cwd(), 'test', path)));
// }

// export function db() {
//   return DI.get(Orm);
// }

// describe('@spinajs/jobs-orm-connection', () => {
//   before(async () => {
//     DI.register(TestConfiguration).as(Configuration);
//     DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
//   });

//   beforeEach(async () => {
//     await DI.resolve(Configuration, [null, null, [dir('./config')]]);
//     await DI.resolve(Orm);
//   });

//   afterEach(async () => {
//     DI.clearCache();
//   });

//   it('should migrate db', async () => {
//     const mTable = await db().Connections.get('orm-event-transport').tableInfo('orm_event_transport__event');
//     const mTable2 = await db().Connections.get('orm-event-transport').tableInfo('orm_event_transport__subscribers');
//     const mTable3 = await db().Connections.get('orm-event-transport').tableInfo('orm_event_transport__queue');

//     const mResult = await db().Connections.get('orm-event-transport').select().from('orm_migrations').first();
//     expect(mTable).to.be.not.null;
//     expect(mTable2).to.be.not.null;
//     expect(mTable3).to.be.not.null;

//     expect(mResult).to.be.not.null;
//     expect((mResult as any).Migration).to.eq('OrmEventTransportInitial_2022_06_28_01_13_00');
//   });

//   it('Should add event', () => {});

//   it('Should clear old events', async () => {});

//   it('Should not fire events after retry count exceeded', async () => {});

//   it('should fire event', async () => {});

//   it('should ack event after success', async () => {});
// });
