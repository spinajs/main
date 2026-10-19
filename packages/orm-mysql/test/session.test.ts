import 'mocha';
import { expect } from 'chai';
import { EventEmitter } from 'node:events';

import { MySqlOrmDriver } from '../src/index.js';

class ProbeDriver extends MySqlOrmDriver {
  public probeOptions() {
    return this.poolOptions();
  }

  public pin(pool: EventEmitter) {
    this.pinSessionZone(pool as never);
  }
}

describe('mysql session time zone', () => {
  it('has mysql2 write and read datetimes as UTC', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);

    expect(d.probeOptions().timezone).to.eq('Z');
  });

  it("sets each new pooled connection's session zone to UTC", () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);
    const pool = new EventEmitter();
    const sent: string[] = [];

    d.pin(pool);
    pool.emit('connection', {
      query: (sql: string, done: (err: Error | null) => void) => {
        sent.push(sql);
        done(null);
      },
    });

    expect(sent).to.deep.eq(["SET time_zone = '+00:00'"]);
  });
});
