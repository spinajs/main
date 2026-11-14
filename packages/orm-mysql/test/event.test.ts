import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';

describe('mysql events', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-event-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const schema = () => driver.Container.resolve(SchemaQueryBuilder, [driver]);

  it('reports events as supported and compiles them', () => {
    expect(driver.supportedFeatures().events).to.eq(true);

    const result = schema()
      .createEvent('cleanup_spine_jobs', (event) => {
        event.every(3, 'MINUTE').comment(`it's a cleanup`).do(new RawQuery('DELETE FROM rtb.spine_jobs WHERE created_at < NOW() - INTERVAL 3 DAY'));
      })
      .toDB();

    expect(result.expression).to.eq(['CREATE EVENT `cleanup_spine_jobs`', 'ON SCHEDULE EVERY 3 MINUTE', 'ON COMPLETION NOT PRESERVE', 'ENABLE', "COMMENT 'it\\'s a cleanup'", 'DO DELETE FROM rtb.spine_jobs WHERE created_at < NOW() - INTERVAL 3 DAY'].join('\n'));
  });

  it('compiles a delete whose cutoff the database computes on every run', () => {
    const result = schema()
      .createEvent('__task_delete_old_entries', (event) => {
        event.every(1, 'DAY').do(driver.del().from('__task_history').where('CreatedAt', '<', driver.ago(7, 'day')));
      })
      .toDB();

    expect(result.expression?.split('\n').at(-1)).to.eq('DO DELETE FROM `__task_history` WHERE `CreatedAt` < (UTC_TIMESTAMP(3) - INTERVAL 7 DAY)');
    expect(result.bindings ?? []).to.deep.eq([]);
  });

  it('drops an event', () => {
    expect(schema().dropEvent('cleanup_spine_jobs').ifExists().toDB().expression).to.eq('DROP EVENT IF EXISTS `cleanup_spine_jobs`');
  });
});
