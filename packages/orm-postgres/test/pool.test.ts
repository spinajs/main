import 'mocha';
import { expect } from 'chai';

import { PostgresOrmDriver } from '../src/index.js';

class ProbeDriver extends PostgresOrmDriver {
  public probe() {
    return this.poolConfig();
  }
}

describe('postgres pool configuration', () => {
  const config = new ProbeDriver({ Driver: 'orm-driver-postgres', Name: 'x', Host: 'h', Database: 'd' }).probe();
  const parse = (oid: number, text: string) => (config.types!.getTypeParser as unknown as (oid: number, format: string) => (value: string) => unknown)(oid, 'text')(text);

  it('runs every session in UTC, after whatever PGOPTIONS sets', () => {
    const options = config.options!.split(/\s+(?=-c\s)/);
    expect(options[options.length - 1]).to.eq('-c TimeZone=UTC');
  });

  it('keeps the PGOPTIONS of the environment in front of the UTC zone', () => {
    const saved = process.env.PGOPTIONS;
    process.env.PGOPTIONS = '-c statement_timeout=5000';
    try {
      const options = new ProbeDriver({ Driver: 'orm-driver-postgres', Name: 'x', Host: 'h', Database: 'd' }).probe().options;
      expect(options).to.eq('-c statement_timeout=5000 -c TimeZone=UTC');
    } finally {
      if (saved === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = saved;
    }
  });

  it('reads timestamp without time zone as UTC and leaves the other types to pg', () => {
    expect((parse(1114, '2026-10-19 12:00:00.123') as Date).toISOString()).to.eq('2026-10-19T12:00:00.123Z');
    expect(parse(1114, 'infinity')).to.eq(Infinity);
    expect((parse(1184, '2026-10-19 14:00:00.123+02') as Date).toISOString()).to.eq('2026-10-19T12:00:00.123Z');
    expect(parse(23, '42')).to.eq(42);
  });
});
