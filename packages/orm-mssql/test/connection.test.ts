import 'mocha';
import { expect } from 'chai';

import { MsSqlOrmDriver } from '../src/index.js';

class ProbeDriver extends MsSqlOrmDriver {
  public probe() {
    return this.connectionConfig();
  }

  public probeDedicated() {
    return this.dedicatedPoolConfig();
  }
}

describe('mssql connection configuration', () => {
  it('binds and decodes datetimes as UTC', () => {
    const config = new ProbeDriver({ Driver: 'orm-driver-mssql', Name: 'x', Host: 'h', Database: 'd' }).probe();

    expect(config.options?.useUTC).to.eq(true);
  });
});

describe('mssql dedicated lock pool configuration', () => {
  it('is the connection config with exactly one connection, so a session-owned lock stays on it', () => {
    const driver = new ProbeDriver({ Driver: 'orm-driver-mssql', Name: 'x', Host: 'h', Database: 'd', Pool: { Max: 8, Min: 0 } });
    const config = driver.probeDedicated();

    expect(config.database).to.eq('d');
    expect(config.pool).to.include({ min: 1, max: 1 });
  });
});
