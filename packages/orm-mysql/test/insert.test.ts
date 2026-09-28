import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';

import { MySqlOrmDriver } from '../src/index.js';

describe('mysql insert', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-insert-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const insert = () => driver.insert().into('campaign_status').values({ CampaignId: 1, Status: 3 });

  it('compiles orReplace to REPLACE INTO', () => {
    const result = insert().orReplace().toDB();

    expect(result.expression).to.eq('REPLACE INTO `campaign_status` (`CampaignId`,`Status`) VALUES (?,?)');
    expect(result.bindings).to.deep.eq([1, 3]);
  });

  it('compiles orIgnore to INSERT IGNORE', () => {
    expect(insert().orIgnore().toDB().expression).to.eq('INSERT IGNORE INTO `campaign_status` (`CampaignId`,`Status`) VALUES (?,?)');
  });

  it('keeps a plain insert plain', () => {
    expect(insert().toDB().expression).to.eq('INSERT INTO `campaign_status` (`CampaignId`,`Status`) VALUES (?,?)');
  });
});
