import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { EventEmitter } from 'node:events';
import sinon from 'sinon';
import { MySqlOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** A pooled connection whose query emits what `emit` sends, on the next turn of the event loop. */
function fakeConnection(emit: (query: EventEmitter) => void) {
  const query = new EventEmitter();
  return {
    query: () => {
      setImmediate(() => emit(query));
      return query;
    },
    pause: () => undefined,
    resume: () => undefined,
    release: sinon.spy(),
    destroy: sinon.spy(),
    stream: { destroy: sinon.spy() },
  };
}

describe('mysql stream (unit)', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  const stream = async (connection: unknown, stopAfter = Number.POSITIVE_INFINITY) => {
    (driver as unknown as { acquireConnection: () => Promise<unknown> }).acquireConnection = () => Promise.resolve(connection);
    const out: unknown[] = [];
    for await (const row of driver.executeStreamOnDb('SELECT 1', [], { batchSize: 2 })) {
      out.push(row);
      if (out.length >= stopAfter) {
        break;
      }
    }
    return out;
  };

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-stream-unit', Driver: 'orm-driver-mysql' }]);
  });

  afterEach(() => DI.clearCache());

  it('releases a connection whose result has ended, also when the loop leaves on the last row', async () => {
    const connection = fakeConnection((q) => {
      [1, 2, 3].forEach((row) => q.emit('result', row));
      q.emit('end');
    });

    expect(await stream(connection, 3)).to.deep.equal([1, 2, 3]);
    expect([connection.release.callCount, connection.destroy.callCount]).to.deep.equal([1, 0]);
  });

  it('destroys the connection and closes its socket when the loop leaves early', async () => {
    const connection = fakeConnection((q) => [1, 2, 3, 4].forEach((row) => q.emit('result', row)));

    expect(await stream(connection, 2)).to.deep.equal([1, 2]);
    expect([connection.release.callCount, connection.destroy.callCount, connection.stream.destroy.callCount]).to.deep.equal([0, 1, 1]);
  });

  it('rejects with the driver error and destroys the connection', async () => {
    const connection = fakeConnection((q) => {
      q.emit('result', 1);
      q.emit('error', Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED' }));
      q.emit('end');
    });

    await expect(stream(connection)).to.be.rejectedWith('Query execution was interrupted');
    expect(connection.destroy.callCount).to.eq(1);
  });

  it('does not keep the connection when starting the query throws', async () => {
    const connection = fakeConnection(() => undefined);
    connection.query = () => {
      throw new TypeError('cannot format the statement');
    };

    await expect(stream(connection)).to.be.rejectedWith('cannot format the statement');
    expect(connection.destroy.callCount).to.eq(1);
  });
});
