import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { EventEmitter } from 'node:events';
import { MsSqlOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** A tedious request in stream mode: emits `total` rows unless paused, then `done`; `failAt` emits an error first. */
class FakeRequest extends EventEmitter {
  public stream = false;
  public pauses = 0;
  public cancelled = false;
  private sent = 0;
  private paused = false;

  constructor(
    private readonly total: number,
    private readonly failAt = Number.POSITIVE_INFINITY,
  ) {
    super();
  }

  public input(): void {}

  public query(): Promise<void> {
    setImmediate(() => this.pump());
    return new Promise<void>(() => undefined);
  }

  public pause(): void {
    this.paused = true;
    this.pauses++;
  }

  public resume(): void {
    this.paused = false;
    setImmediate(() => this.pump());
  }

  public cancel(): void {
    this.cancelled = true;
    setImmediate(() => {
      this.emit('error', Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
      this.emit('done');
    });
  }

  private pump(): void {
    while (!this.paused && !this.cancelled && this.sent < this.total) {
      if (this.sent === this.failAt) {
        this.emit('error', new Error('Arithmetic overflow error'));
        this.emit('done');
        return;
      }
      this.emit('row', { Id: ++this.sent });
    }
    if (!this.cancelled && this.sent >= this.total) {
      this.emit('done');
    }
  }
}

describe('mssql stream over a request (unit)', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  const stream = async (request: FakeRequest, stopAfter = Number.POSITIVE_INFINITY) => {
    (driver as unknown as { _connectionPool: unknown })._connectionPool = { request: () => request };
    let count = 0;
    for await (const _ of driver.executeStreamOnDb('SELECT 1', [], { batchSize: 100 })) {
      if (++count >= stopAfter) {
        break;
      }
    }
    return count;
  };

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-stream-unit', Driver: 'orm-driver-mssql' }]);
  });

  afterEach(() => DI.clearCache());

  it('reads every row in stream mode, pausing the request once per batch', async () => {
    const request = new FakeRequest(1000);

    expect(await stream(request)).to.eq(1000);
    expect([request.stream, request.pauses, request.cancelled]).to.deep.equal([true, 10, false]);
  });

  it('cancels the request when the loop leaves early and settles once it is done', async () => {
    const request = new FakeRequest(1000);

    expect(await stream(request, 150)).to.eq(150);
    expect(request.cancelled).to.eq(true);
  });

  it('rejects with the error that arrives mid-stream', async () => {
    await expect(stream(new FakeRequest(1000, 250))).to.be.rejectedWith('Arithmetic overflow error');
  });
});
