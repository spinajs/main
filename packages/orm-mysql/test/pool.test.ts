import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { writeFileSync, unlinkSync } from 'fs';
import { AddressInfo, connect as connectTcp } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import * as mysql from 'mysql2';
import ssh2 from 'ssh2';
import { ConnectionState } from '@spinajs/orm';
import { MySqlOrmDriver, MySqlSSHOrmDriver } from '../src/index.js';

const expect = chai.expect;
const { Server: SSHServer, utils: sshUtils } = ssh2;
chai.use(chaiAsPromised);

class ProbeDriver extends MySqlOrmDriver {
  public probe() {
    return (this as any).resolvedPoolOptions();
  }
}

describe('pool metrics', () => {
  it('reports zeros before the pool exists rather than throwing', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);

    expect(d.poolMetrics()).to.deep.equal({ Size: 0, InUse: 0, Waiting: 0 });
  });

  it('reads mysql2s internal pool bookkeeping', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);
    (d as any).Pool = {
      _allConnections: [1, 2, 3, 4],
      _freeConnections: [1],
      _connectionQueue: [1, 2],
    };

    expect(d.poolMetrics()).to.deep.equal({ Size: 4, InUse: 3, Waiting: 2 });
  });

  it('degrades to zeros when mysql2 renames its internals', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);
    (d as any).Pool = {};

    expect(d.poolMetrics()).to.deep.equal({ Size: 0, InUse: 0, Waiting: 0 });
  });
});

describe('pool options', () => {
  it('defaults when nothing is configured', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);

    expect(d.probe()).to.deep.equal({ Min: 0, Max: 10, IdleTimeout: 30000, AcquireTimeout: 10000 });
  });

  it('honours the deprecated PoolLimit as Max', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x', PoolLimit: 3 } as any);

    expect(d.probe().Max).to.equal(3);
  });

  it('Pool.Max wins over PoolLimit', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x', PoolLimit: 3, Pool: { Max: 7 } } as any);

    expect(d.probe().Max).to.equal(7);
  });

  it('carries every configured field through', () => {
    const d = new ProbeDriver({
      Driver: 'orm-driver-mysql',
      Name: 'x',
      Pool: { Min: 2, Max: 20, IdleTimeout: 1000, AcquireTimeout: 500 },
    } as any);

    expect(d.probe()).to.deep.equal({ Min: 2, Max: 20, IdleTimeout: 1000, AcquireTimeout: 500 });
  });
});

/**
 * A mysql2 protocol server that accepts any login and answers every query with OK, so
 * connect() can be exercised without a database.
 */
async function fakeMySqlServer() {
  const clients: any[] = [];
  const server = (mysql as any).createServer();

  server.on('connection', (conn: any) => {
    conn.serverHandshake({ protocolVersion: 10, serverVersion: '8.0.0', connectionId: clients.length + 1, statusFlags: 2, characterSet: 8, capabilityFlags: 0xffffff });
    conn.on('error', () => undefined);
    conn.on('query', () => conn.writeOk());
    clients.push(conn);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    clients,
    port: server._server.address().port as number,
    close: () => new Promise<void>((resolve) => server._server.close(() => resolve())),
  };
}

const silenced = <T>(driver: T): T => {
  (driver as any).Log = { info: () => undefined, warn: () => undefined, trace: () => undefined };
  return driver;
};

const getConnection = (pool: mysql.Pool) => new Promise<mysql.PoolConnection>((resolve, reject) => pool.getConnection((err, c) => (err ? reject(err) : resolve(c))));

describe('connect', function () {
  this.timeout(10000);

  let server: Awaited<ReturnType<typeof fakeMySqlServer>>;
  let driver: MySqlOrmDriver;

  const options = (extra: any = {}) => ({ Driver: 'orm-driver-mysql', Name: 'x', Host: '127.0.0.1', Port: server.port, User: 'u', Password: 'p', Resilience: { HealthCheckInterval: 0 }, ...extra });

  beforeEach(async () => {
    server = await fakeMySqlServer();
  });

  afterEach(async () => {
    await driver?.disconnect().catch(() => undefined);
    await server.close();
  });

  it('passes Encoding and Options to mysql2', async () => {
    driver = silenced(new MySqlOrmDriver(options({ Encoding: 'LATIN1_SWEDISH_CI', Options: { connectAttributes: { app: 'shop' } } }) as any));
    await driver.connect();

    expect(server.clients[0].clientHelloReply.charsetNumber).to.equal(8);
    expect(server.clients[0].clientHelloReply.connectAttributes.app).to.equal('shop');
    expect(driver.State).to.equal(ConnectionState.Connected);
  });

  it('ends the replaced pool once its borrowed connection is back', async () => {
    driver = silenced(new MySqlOrmDriver(options() as any));
    await driver.connect();

    const first = (driver as any).Pool as mysql.Pool;
    const borrowed = await getConnection(first);
    await driver.connect();

    await new Promise<void>((resolve, reject) => borrowed.query('SELECT 1', (err) => (err ? reject(err) : resolve())));
    borrowed.release();
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await expect(getConnection(first)).to.be.rejectedWith('Pool is closed.');
  });

  it('keeps the working pool when a reconnect fails', async () => {
    driver = silenced(new MySqlOrmDriver(options() as any));
    await driver.connect();
    const first = (driver as any).Pool as mysql.Pool;

    driver.Options.Port = 1;
    await expect(driver.connect()).to.be.rejected;

    expect((driver as any).Pool).to.equal(first);
    (await getConnection(first)).release();
  });

  it('tunnels every pooled connection through its own SSH channel', async () => {
    const keys = sshUtils.generateKeyPairSync('ed25519');
    const keyFile = join(tmpdir(), `orm-mysql-ssh-test-${process.pid}`);
    writeFileSync(keyFile, keys.private);

    const sshd = new SSHServer({ hostKeys: [sshUtils.generateKeyPairSync('ed25519').private] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept());
      client.on('tcpip', (accept, _reject, info) => {
        const channel = accept();
        const socket = connectTcp(info.destPort, info.destIP);
        channel.pipe(socket).pipe(channel);
        socket.on('error', () => channel.close());
      });
      client.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => sshd.listen(0, '127.0.0.1', resolve));

    try {
      driver = silenced(new MySqlSSHOrmDriver(options({ Pool: { Max: 2 }, SSH: { Host: '127.0.0.1', Port: (sshd.address() as AddressInfo).port, User: 'deploy', PrivateKey: keyFile } }) as any));
      await driver.connect();

      const pool = (driver as any).Pool as mysql.Pool;
      const [a, b] = await Promise.all([getConnection(pool), getConnection(pool)]);
      const query = (c: mysql.PoolConnection) => new Promise<void>((resolve, reject) => c.query('SELECT 1', (err) => (err ? reject(err) : resolve())));
      await Promise.all([query(a), query(b)]);
      a.release();
      b.release();

      expect(server.clients.length).to.equal(2);
      expect(driver.State).to.equal(ConnectionState.Connected);
    } finally {
      await driver.disconnect();
      await new Promise((resolve) => sshd.close(resolve));
      unlinkSync(keyFile);
    }
  });
});

describe('tableInfo', () => {
  class CannedDriver extends MySqlOrmDriver {
    public statements: string[] = [];

    constructor(private canned: (stmt: string) => any[]) {
      super({ Driver: 'orm-driver-mysql', Name: 'x', Database: 'shop' } as any);
      silenced(this);
    }

    public executeOnDb(stmt: string): Promise<any> {
      this.statements.push(stmt);
      return Promise.resolve(this.canned(stmt));
    }
  }

  it('returns null for a table that does not exist', async () => {
    const d = new CannedDriver(() => []);

    expect(await d.tableInfo('missing')).to.equal(null);
  });

  it('reads the indexes of the table in the requested schema', async () => {
    const column = { COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', EXTRA: 'auto_increment', COLUMN_DEFAULT: null };
    const d = new CannedDriver((stmt) => {
      if (stmt.startsWith('SELECT')) return [column];
      if (stmt.startsWith('SHOW FULL TABLES')) return [{ Table_type: 'BASE TABLE' }];
      return [{ Key_name: 'PRIMARY', Column_name: 'Id', Non_unique: 0 }];
    });

    const [id] = await d.tableInfo('orders', 'archive');

    expect(d.statements[2]).to.equal('SHOW INDEXES FROM `orders` FROM `archive`');
    expect(id.PrimaryKey).to.equal(true);
  });
});
