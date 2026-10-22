import 'mocha';
import { expect } from 'chai';
import { EventEmitter } from 'node:events';

import { QueryContext } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';

type ErrorChain = { inner?: unknown; cause?: unknown; message?: unknown } | null | undefined;

class ProbeDriver extends MySqlOrmDriver {
  public probeOptions() {
    return this.poolConfig();
  }

  public pin(pool: EventEmitter) {
    this.pinSessionZone(pool as never);
  }
}

describe('mysql session time zone', () => {
  it('has mysql2 write and read datetimes as UTC', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' });

    expect(d.probeOptions().timezone).to.eq('Z');
  });

  it("sets each new pooled connection's session zone to UTC", () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' });
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

  describe('when the session zone cannot be set', () => {
    function pooled(zoneError: Error | null) {
      const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' });
      const pool = Object.assign(new EventEmitter(), {
        getConnection(done: (err: Error | null, connection?: unknown) => void) {
          pool.emit('connection', connection);
          done(null, connection);
        },
      });
      const connection = {
        sent: [] as string[],
        destroyed: false,
        released: false,
        query(sql: string, params: unknown, done?: (err: Error | null, rows?: unknown) => void) {
          const cb = (typeof params === 'function' ? params : done) as (err: Error | null, rows?: unknown) => void;
          connection.sent.push(sql);
          cb(sql.startsWith('SET time_zone') ? zoneError : null, []);
        },
        beginTransaction(done: (err: Error | null) => void) {
          done(null);
        },
        destroy() {
          connection.destroyed = true;
        },
        release() {
          connection.released = true;
        },
      };
      d.pin(pool);
      Object.assign(d, { Pool: pool, Log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
      return { d, connection };
    }

    it('fails the statement and destroys the connection instead of running it outside UTC', async () => {
      const { d, connection } = pooled(new Error("Unknown or incorrect time zone: '+00:00'"));

      const err = await d.executeOnDb('SELECT 1', [], QueryContext.Select).then(
        () => null,
        (e: Error) => e,
      );

      expect(err, 'executeOnDb should reject').to.be.instanceOf(Error);
      const messages: string[] = [];
      for (let e: ErrorChain = err; e; e = (e.inner ?? e.cause) as ErrorChain) messages.push(String(e.message));
      expect(messages.join(' | ')).to.contain('could not set the session time zone of connection x to UTC');
      expect(connection.sent).to.deep.eq(["SET time_zone = '+00:00'"]);
      expect(connection.destroyed).to.eq(true);
      expect(connection.released).to.eq(false);
    });

    it('fails a transaction begin the same way', async () => {
      const { d, connection } = pooled(new Error("Unknown or incorrect time zone: '+00:00'"));

      const err = await d['_begin']().then(
        () => null,
        (e: Error) => e,
      );

      expect(err, '_begin should reject').to.be.instanceOf(Error);
      expect(connection.sent).to.deep.eq(["SET time_zone = '+00:00'"]);
      expect(connection.destroyed).to.eq(true);
    });

    it('runs the statement once the zone is set', async () => {
      const { d, connection } = pooled(null);

      await d.executeOnDb('SELECT 1', [], QueryContext.Select);

      expect(connection.sent).to.deep.eq(["SET time_zone = '+00:00'", 'SELECT 1']);
      expect(connection.released).to.eq(true);
    });
  });
});
