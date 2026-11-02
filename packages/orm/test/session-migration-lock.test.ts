import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { IMigrationLockHandle, IMigrationLockRequest, IMigrationLockSession, MigrationLock, MigrationLockLostException, OrmException, SessionMigrationLock } from '../src/index.js';
import { OrmDriver } from '../src/driver.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const request = (over: Partial<IMigrationLockRequest> = {}): IMigrationLockRequest => ({ key: 'k', lockTable: 'spinajs_migration_lock', timeout: 2_000, staleAfter: 600_000, ...over });

/** One shared fake server: `holder` owns the session lock, `row` the lock-table row. */
class Server {
  public holder: FakeSession | undefined;
  public row: string | undefined;
  public events: string[] = [];
}

class FakeSession implements IMigrationLockSession {
  public readonly name = 'fake lock (k)';
  public dead = false;

  constructor(
    protected server: Server,
    protected id: string,
  ) {}

  public async tryLock() {
    this.server.events.push(`try:${this.id}`);
    if (this.server.holder && this.server.holder !== this) {
      return false;
    }
    this.server.holder = this;
    return true;
  }

  public async isLocked() {
    if (this.dead) {
      throw new Error('socket closed');
    }
    return this.server.holder === this;
  }

  public async unlock() {
    this.server.events.push(`unlock:${this.id}`);
    if (this.server.holder === this) {
      this.server.holder = undefined;
    }
  }

  public async close() {
    this.server.events.push(`close:${this.id}`);
  }
}

class FakeRowLock extends MigrationLock {
  constructor(
    protected server: Server,
    protected id: string,
  ) {
    super(undefined as unknown as OrmDriver);
  }

  public async acquire(req: IMigrationLockRequest): Promise<IMigrationLockHandle> {
    if (this.server.row) {
      throw new OrmException(`Could not acquire migration lock on connection x within ${req.timeout}ms - held by ${this.server.row}`);
    }
    this.server.row = this.id;
    this.server.events.push(`row:${this.id}`);

    return {
      holder: this.id,
      assertHeld: async () => {
        if (this.server.row !== this.id) {
          throw new MigrationLockLostException('row lost');
        }
      },
      release: async () => {
        this.server.events.push(`unrow:${this.id}`);
        this.server.row = undefined;
      },
    };
  }

  public async isHeld() {
    return this.server.row !== undefined;
  }
}

class FakeSessionLock extends SessionMigrationLock {
  public session: FakeSession;

  constructor(
    protected server: Server,
    protected id: string,
  ) {
    super({ Options: { Name: 'x' } } as OrmDriver);
  }

  protected async openSession() {
    this.session = new FakeSession(this.server, this.id);
    return this.session;
  }

  protected async isLockedByAnySession() {
    return this.server.holder !== undefined;
  }

  protected tableLock() {
    return new FakeRowLock(this.server, this.id);
  }
}

describe('SessionMigrationLock', () => {
  it('takes the session lock, then the lock-table row, and releases them in reverse', async () => {
    const server = new Server();
    const lock = await new FakeSessionLock(server, 'a').acquire(request());

    expect(lock.holder).to.eq('fake lock (k)');
    await lock.assertHeld();
    await lock.release();

    expect(server.events).to.eql(['try:a', 'row:a', 'unrow:a', 'unlock:a', 'close:a']);
  });

  it('polls while another session holds the lock, then times out naming it and closes its own session', async () => {
    const server = new Server();
    const first = await new FakeSessionLock(server, 'a').acquire(request());

    await expect(new FakeSessionLock(server, 'b').acquire(request({ timeout: 700 }))).to.be.rejectedWith(OrmException, 'Could not acquire migration lock on connection x within 700ms - another migration run holds fake lock (k)');
    expect(server.events.filter((e) => e === 'try:b').length).to.be.greaterThan(1);
    expect(server.events).to.include('close:b');

    await first.release();
    await (await new FakeSessionLock(server, 'b').acquire(request({ timeout: 700 }))).release();
  }).timeout(5_000);

  it('a row held by an earlier release keeps the run out and gives the session lock back', async () => {
    const server = new Server();
    server.row = 'old-release-host:42';

    await expect(new FakeSessionLock(server, 'a').acquire(request())).to.be.rejectedWith(/held by old-release-host:42/);

    expect(server.holder).to.be.undefined;
    expect(server.events).to.eql(['try:a', 'unlock:a', 'close:a']);
  });

  it('assertHeld() reports a lost session lock, a dead session and a lost row as MigrationLockLostException', async () => {
    const server = new Server();
    const locker = new FakeSessionLock(server, 'a');
    const lock = await locker.acquire(request());

    server.holder = undefined;
    await expect(lock.assertHeld()).to.be.rejectedWith(MigrationLockLostException, 'Migration lock on connection x was lost: its session no longer holds fake lock (k)');

    server.holder = locker.session;
    locker.session.dead = true;
    await expect(lock.assertHeld()).to.be.rejectedWith(MigrationLockLostException, /no longer holds fake lock \(k\) \( socket closed \)/);

    locker.session.dead = false;
    server.row = 'thief';
    await expect(lock.assertHeld()).to.be.rejectedWith(MigrationLockLostException, 'row lost');
  });

  it('isHeld() is true while either the session lock or the row is held', async () => {
    const server = new Server();
    const locker = new FakeSessionLock(server, 'probe');

    expect(await locker.isHeld(request())).to.be.false;
    server.row = 'old-release-host:42';
    expect(await locker.isHeld(request())).to.be.true;
    server.row = undefined;
    server.holder = new FakeSession(server, 'a');
    expect(await locker.isHeld(request())).to.be.true;
  });
});
