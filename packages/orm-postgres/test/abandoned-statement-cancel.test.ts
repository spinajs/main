import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { OrmException, QueryContext } from '@spinajs/orm';
import * as net from 'node:net';
import pg from 'pg';
import sinon from 'sinon';
import { PostgresOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const KEY = { processID: 4242, secretKey: 777 };

class ProbeDriver extends PostgresOrmDriver {
  public readonly cancels: Array<Promise<void> | undefined> = [];

  public clientClass(): pg.PoolConfig['Client'] {
    return this.poolConfig().Client;
  }

  public static rearmNoCancelKeyWarning(): void {
    PostgresOrmDriver.WarnedNoCancelKey = false;
  }

  public logger() {
    return this.Log;
  }

  public usePool(client: unknown): void {
    this.Pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
  }

  protected cancelAbandoned(client: pg.PoolClient): Promise<void> | undefined {
    const sent = super.cancelAbandoned(client);
    this.cancels.push(sent);
    return sent;
  }
}

/** A stand-in postmaster: records the bytes of every connection made to it. */
async function postmaster() {
  const requests: Buffer[] = [];
  let arrived: () => void = () => undefined;
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      requests.push(Buffer.concat(chunks));
      socket.end();
      arrived();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no TCP address');
  }

  return {
    port: address.port,
    requests,
    next: () => new Promise<void>((resolve) => (arrived = resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A peer that accepts and then neither answers nor closes: a proxy holding the connection. */
async function silentPeer() {
  const held: net.Socket[] = [];
  let accepted: () => void = () => undefined;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    held.push(socket);
    socket.resume();
    accepted();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no TCP address');
  }

  return {
    port: address.port,
    next: () => new Promise<void>((resolve) => (accepted = resolve)),
    close: () => {
      held.forEach((socket) => socket.destroy());
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Whether `promise` settles within a few turns of the event loop: enough for socket events on localhost, no wall-clock wait. */
async function settles(promise: Promise<unknown> | undefined): Promise<boolean> {
  let settled = false;
  void promise?.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < 20 && !settled; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return settled;
}

const decode = (request: Buffer) => [request.readInt32BE(0), request.readInt32BE(4), request.readInt32BE(8), request.readInt32BE(12)];

describe('postgres abandoned statement cancel (unit)', function () {
  this.timeout(15000);

  let driver: ProbeDriver;
  let server: Awaited<ReturnType<typeof postmaster>>;

  const resolveDriver = async (entry: Record<string, unknown> = {}) => {
    driver = await DI.resolve(ProbeDriver, [{ Name: 'pg-cancel-unit', Driver: 'orm-driver-postgres', ...entry }]);
  };

  /** A client of the pool's own class whose backend sent `key`, answering every statement with `outcome`. */
  const pooledClient = (outcome: () => Promise<unknown>, key: object | null = KEY, port = server.port) => {
    const Client = driver.clientClass();
    expect(Client, 'the pool builds its clients from a class that keeps the cancel key').to.exist;
    const client = new Client!();
    if (!(client instanceof pg.Client)) {
      throw new Error('the pool client class is not a pg.Client');
    }
    client.host = '127.0.0.1';
    client.port = port;
    if (key) {
      client.connection.emit('backendKeyData', key);
    }
    const release = sinon.spy();
    driver.usePool(Object.assign(client, { query: outcome, release }));
    return { client, release };
  };

  const timedOut = () => Promise.reject(new Error('Query read timeout'));

  beforeEach(async () => {
    ProbeDriver.rearmNoCancelKeyWarning();
    server = await postmaster();
    await resolveDriver();
  });

  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
    await server.close();
  });

  it('sends one CancelRequest with the backend key when the statement got no answer, and destroys the client', async () => {
    const arrived = server.next();
    const { release } = pooledClient(timedOut);

    const err: unknown = await driver.executeOnDb('SELECT pg_sleep(30)', [], QueryContext.Select).then(
      () => expect.fail('the statement resolved'),
      (e: unknown) => e,
    );
    expect(err).to.be.instanceOf(OrmException).with.nested.property('inner.message', 'Query read timeout');
    expect(release.args).to.deep.equal([[true]]);

    await arrived;
    expect(server.requests.map(decode)).to.deep.equal([[16, 80877102, KEY.processID, KEY.secretKey]]);
  });

  it('sends nothing after a server answer or a result', async () => {
    for (const outcome of [
      () => Promise.reject(Object.assign(new pg.DatabaseError('canceling statement due to statement timeout', 0, 'error'), { code: '57014' })),
      () => Promise.reject(Object.assign(new pg.DatabaseError('relation "nope" does not exist', 0, 'error'), { code: '42P01' })),
      () => Promise.resolve({ rows: [], rowCount: 0 }),
    ]) {
      pooledClient(outcome);
      await driver.executeOnDb('SELECT 1', [], QueryContext.Select).catch(() => undefined);
    }
    expect(driver.cancels).to.deep.equal([]);
  });

  it('sends nothing when the socket already closed, the client has no key, or the client is not a pg client', async () => {
    const { client } = pooledClient(() => Promise.reject(new Error('Connection terminated unexpectedly')));
    client.connection.emit('end');
    await expect(driver.executeOnDb('SELECT 1', [], QueryContext.Select)).to.be.rejected;

    pooledClient(timedOut, null);
    await expect(driver.executeOnDb('SELECT 1', [], QueryContext.Select)).to.be.rejected;

    // the PGlite pool adapter's shape
    driver.usePool({ query: timedOut, release: sinon.spy() });
    await expect(driver.executeOnDb('SELECT 1', [], QueryContext.Select)).to.be.rejected;

    expect(driver.cancels).to.deep.equal([undefined, undefined, undefined]);
  });

  it('sends nothing when Options.CancelAbandonedStatements is false', async () => {
    await resolveDriver({ Options: { CancelAbandonedStatements: false } });
    const { release } = pooledClient(timedOut);
    await expect(driver.executeOnDb('SELECT 1', [], QueryContext.Select)).to.be.rejected;
    expect(release.args).to.deep.equal([[true]]);
    expect(driver.cancels).to.deep.equal([undefined]);
  });

  it('keeps the caller error when the cancel cannot reach the server', async () => {
    const closed = await postmaster();
    await closed.close();
    pooledClient(timedOut, KEY, closed.port);
    const debug = sinon.stub(driver.logger(), 'debug');

    const err: unknown = await driver.executeOnDb('SELECT 1', [], QueryContext.Select).then(
      () => expect.fail('the statement resolved'),
      (e: unknown) => e,
    );
    expect(err).to.be.instanceOf(OrmException).with.nested.property('inner.message', 'Query read timeout');
    expect(driver.cancels).to.have.length(1);
    await expect(driver.cancels[0]).to.be.fulfilled;
    expect(debug.callCount, 'the failure is logged at debug').to.equal(1);
    expect(debug.args[0][0]).to.have.nested.property('error.code', 'ECONNREFUSED');
  });

  it('sends one CancelRequest when a stream is abandoned', async () => {
    const arrived = server.next();
    const { client, release } = pooledClient(timedOut);
    // what pg does to a submitted cursor when its query_timeout fires
    Object.assign(client, { query: (cursor: { handleError(err: Error): void }) => cursor.handleError(new Error('Query read timeout')) });

    await expect(driver.executeStreamOnDb('SELECT 1', [], { batchSize: 10 })[Symbol.asyncIterator]().next()).to.be.rejected;
    expect(release.args).to.deep.equal([[true]]);
    await arrived;
    expect(server.requests.map(decode)).to.deep.equal([[16, 80877102, KEY.processID, KEY.secretKey]]);
  });

  it('gives the caller its error while the cancel is still in flight', async () => {
    const peer = await silentPeer();
    pooledClient(timedOut, KEY, peer.port);
    try {
      await expect(driver.executeOnDb('SELECT 1', [], QueryContext.Select)).to.be.rejectedWith(OrmException);
      expect(await settles(driver.cancels[0]), 'the cancel is still in flight').to.equal(false);
    } finally {
      await peer.close();
    }
    await expect(driver.cancels[0]).to.be.fulfilled;
  });

  it('ends the cancel connection within a bound of its own when Pool.AcquireTimeout is 0', async () => {
    await resolveDriver({ Pool: { AcquireTimeout: 0 } });
    const peer = await silentPeer();
    const accepted = peer.next();
    pooledClient(timedOut, KEY, peer.port);
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await expect(driver.executeOnDb('SELECT 1', [], QueryContext.Select)).to.be.rejectedWith(OrmException);
      await accepted;
      clock.tick(60_000);
      expect(await settles(driver.cancels[0]), 'the cancel connection ended').to.equal(true);
    } finally {
      clock.restore();
      await peer.close();
    }
  });

  it('warns once when a statement is abandoned on a client that never got a cancel key', async () => {
    const warn = sinon.stub(driver.logger(), 'warn');
    const { client } = pooledClient(() => Promise.reject(new Error('Connection terminated unexpectedly')), null);
    client.connection.emit('end');
    await expect(driver.executeOnDb('SELECT 1', [], QueryContext.Select)).to.be.rejected;
    expect(warn.callCount, 'a closed socket is no reason to warn').to.equal(0);

    for (let i = 0; i < 2; i++) {
      pooledClient(timedOut, null);
      await expect(driver.executeOnDb('SELECT 1', [], QueryContext.Select)).to.be.rejected;
    }
    expect(warn.callCount).to.equal(1);
    expect(warn.args[0][1]).to.contain('will not be cancelled');
  });

});
