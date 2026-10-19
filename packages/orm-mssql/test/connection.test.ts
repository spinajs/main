import 'mocha';
import { expect } from 'chai';

import { MsSqlOrmDriver } from '../src/index.js';

class ProbeDriver extends MsSqlOrmDriver {
  public probe() {
    return this.connectionConfig();
  }
}

describe('mssql connection configuration', () => {
  it('binds and decodes datetimes as UTC', () => {
    const config = new ProbeDriver({ Driver: 'orm-driver-mssql', Name: 'x', Host: 'h', Database: 'd' } as any).probe();

    expect(config.options?.useUTC).to.eq(true);
  });
});
