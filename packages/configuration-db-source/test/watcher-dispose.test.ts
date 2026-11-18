import { expect } from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { DI, IContainer, PerChildInstance, SyncService } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { InternalLogger } from '@spinajs/internal-logger';

import { CONFIGURATION_DB_CHANGED_EVENT, DbConfig, DbConfigSourceBotstrapper, DbConfigValueConverter, DbConfigWatcher } from '../src/index.js';
import { isWatchDisposed, startWatch } from '../src/watcher.js';

/** The private members these tests drive. */
interface Internals {
  Converter: DbConfigValueConverter;
  startWatchTimer(container: IContainer): void;
  syncExposedOptions(container: IContainer): Promise<void>;
  saveConfigOptions(v: unknown): Promise<void>;
}

const internals = (b: DbConfigSourceBotstrapper) => b as unknown as Internals;

const ROW = { Slug: 'watcherDispose.polled', Type: 'string', Value: 'new', Watch: 1, Exposed: 1 };

/** Stands in for the Orm in the dispose order: a service the container disposes, which records when it closed. */
@PerChildInstance()
class FakeOrm extends SyncService {
  public closed = false;

  public onClose: () => void = () => undefined;

  public async dispose(): Promise<void> {
    this.closed = true;
    this.onClose();
  }
}

/** A replacement registered the documented way, `.as(DbConfigWatcher)`. */
class ReplacedWatcher extends DbConfigWatcher {}

describe('ending the watch timer through dispose', function () {
  let clock: sinon.SinonFakeTimers;
  let child: IContainer;
  let bootstrapper: DbConfigSourceBotstrapper;
  let polls: sinon.SinonStub;
  let interval: number;

  /**
   * One exposed option, a configuration, and an Orm whose `configuration` table exists or not. Services resolve in
   * `child`, so `child.dispose()` disposes the watcher as a container dispose does.
   */
  function containerOf(tableExists: boolean, configuration: unknown = { get: () => undefined, set: () => undefined }): { container: IContainer; orm: unknown } {
    const orm = { Connections: new Map([['default', { schema: () => ({ tableExists: async () => tableExists }) }]]) };
    const vars = [{ path: 'watcherDispose.swept', options: { expose: true, exposeOptions: { type: 'string', group: 'g' } } }];
    const container = {
      get: (key: unknown) => (key === Orm ? orm : key === Configuration ? configuration : vars),
      resolve: (type: typeof DbConfigWatcher) => child.resolve(type),
      uncache: (type: typeof DbConfigWatcher) => child.uncache(type),
      isCached: (instance: unknown) => child.isCached(instance),
    } as unknown as IContainer;

    return { container, orm };
  }

  const watcher = () => child.get(DbConfigWatcher) as DbConfigWatcher;

  /** A migration signal on a database whose table exists; the sweep's inserts succeed. */
  async function migrationSignal(configuration?: unknown): Promise<void> {
    internals(bootstrapper).saveConfigOptions = sinon.stub().resolves();
    const migrated = containerOf(true, configuration);
    DI.emit('orm.migrated', migrated.container, migrated.orm, []);
    await bootstrapper.whenSwept();
  }

  /** The real poll over a stubbed query the test releases, a configuration spy and a listener of the change event. */
  async function heldPoll() {
    polls.restore();
    const poll = sinon.spy(bootstrapper, 'refreshWatched');
    bootstrapper.authzDomain = 'watcher-dispose-unguarded';
    internals(bootstrapper).Converter = await DI.resolve(DbConfigValueConverter);

    const releases: Array<(rows: unknown[]) => void> = [];
    const failures: Array<(err: Error) => void> = [];
    const select = sinon.stub(DbConfig, 'select').callsFake(
      () =>
        ({
          asRaw: () =>
            new Promise((resolve, reject) => {
              releases.push(resolve);
              failures.push(reject);
            }),
        }) as unknown as ReturnType<typeof DbConfig.select>,
    );
    const set = sinon.spy();
    const changed = sinon.spy();
    DI.on(CONFIGURATION_DB_CHANGED_EVENT, changed);

    return {
      poll,
      set,
      changed,
      configuration: { get: () => 'old', set },
      release: () => {
        failures.shift();
        releases.shift()?.([ROW]);
      },
      /** The query fails, as one on a closed connection does. */
      fail: (err: Error) => {
        releases.shift();
        failures.shift()?.(err);
      },
      /** The poll's own end, so the assertions also hold for a dispose() that would not wait for it. */
      ended: () => poll.firstCall.returnValue,
      polls: () => poll.callCount,
      restore: () => {
        DI.off(CONFIGURATION_DB_CHANGED_EVENT, changed);
        select.restore();
        // queries still held would keep the afterEach dispose waiting
        failures.splice(0);
        releases.splice(0).forEach((r) => r([]));
      },
    };
  }

  /** The timer started and its first poll in flight, the query held. */
  async function timerWithPollInFlight(held: Awaited<ReturnType<typeof heldPoll>>): Promise<void> {
    internals(bootstrapper).startWatchTimer(containerOf(false, held.configuration).container);
    await clock.tickAsync(interval);
  }

  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    child = DI.child();
    bootstrapper = new DbConfigSourceBotstrapper();
    polls = sinon.stub(bootstrapper, 'refreshWatched').resolves();
    // the interval startWatchTimer() reads; other suites in this process may have registered one
    interval = DI.get<{ value: number }>('__config_watch_interval__')?.value || 3 * 60 * 1000;
  });

  afterEach(async () => {
    // before the clock is restored, so a timer is cleared on the clock that set it
    await child.dispose();
    bootstrapper.unbind();
    clock.restore();
  });

  it('polls on every interval until the watcher is disposed, and not after', async () => {
    internals(bootstrapper).startWatchTimer(containerOf(false).container);

    await clock.tickAsync(interval);
    await clock.tickAsync(interval);
    expect(polls.callCount).to.equal(2);

    await watcher().dispose();
    await clock.tickAsync(interval * 3);

    expect(polls.callCount).to.equal(2);
  });

  it('settles dispose() once the poll in flight has finished, and schedules no further one', async () => {
    let finish: () => void = () => undefined;
    polls.callsFake(() => new Promise<void>((resolve) => (finish = resolve)));
    internals(bootstrapper).startWatchTimer(containerOf(false).container);
    await clock.tickAsync(interval);

    let settled = false;
    const disposing = watcher().dispose().then(() => (settled = true));
    await clock.tickAsync(0);
    expect(settled, 'dispose() waits for the poll').to.equal(false);

    finish();
    await disposing;
    await clock.tickAsync(interval * 3);

    expect(polls.callCount).to.equal(1);
  });

  it('applies nothing and raises no event from a poll whose query returns after dispose()', async () => {
    const held = await heldPoll();
    try {
      await timerWithPollInFlight(held);

      const disposing = watcher().dispose();
      held.release();
      await disposing;
      await held.ended();

      expect(held.set.called).to.equal(false);
      expect(held.changed.called).to.equal(false);
    } finally {
      held.restore();
    }
  });

  it('applies nothing from a poll held across the container dispose, and polls no more', async () => {
    const held = await heldPoll();
    try {
      await timerWithPollInFlight(held);

      const disposing = child.dispose();
      await clock.tickAsync(0);
      held.release();
      await disposing;
      await held.ended();
      await clock.tickAsync(interval * 2);

      expect(held.set.called).to.equal(false);
      expect(held.changed.called).to.equal(false);
      expect(held.polls()).to.equal(1);
    } finally {
      held.restore();
    }
  });

  it('disposes the watcher before the Orm, so no poll runs on a closed connection', async () => {
    await bootstrapper.bootstrap();
    const orm = child.resolve(FakeOrm);
    let finish: () => void = () => undefined;
    const ormClosedDuringPoll: boolean[] = [];
    polls.callsFake(async () => {
      ormClosedDuringPoll.push(orm.closed);
      await new Promise<void>((resolve) => (finish = resolve));
      ormClosedDuringPoll.push(orm.closed);
    });
    await migrationSignal();
    await clock.tickAsync(interval);

    const disposing = child.dispose();
    await clock.tickAsync(0);
    expect(orm.closed, 'the Orm waits for the watcher').to.equal(false);

    finish();
    await disposing;
    await clock.tickAsync(interval * 2);

    expect(ormClosedDuringPoll).to.deep.equal([false, false]);
    expect(orm.closed).to.equal(true);
    expect(polls.callCount).to.equal(1);
  });

  it('applies nothing from a poll whose Orm the container disposed first, and the dispose does not fail', async () => {
    const held = await heldPoll();
    const error = sinon.stub(InternalLogger, 'error');
    try {
      // application code resolved the watcher before the Orm, so the container disposes the Orm first
      child.resolve(DbConfigWatcher);
      const orm = child.resolve(FakeOrm);
      orm.onClose = () => held.fail(new Error('connection closed'));
      await timerWithPollInFlight(held);

      await child.dispose();
      await held.ended();

      expect(held.set.called).to.equal(false);
      expect(held.changed.called).to.equal(false);
      expect(error.calledWithMatch(sinon.match.any, 'Failed to refresh watched config values from db')).to.equal(true);
    } finally {
      error.restore();
      held.restore();
    }
  });

  it('applies nothing from a poll held across dispose() and a new bootstrap()', async () => {
    const held = await heldPoll();
    try {
      await timerWithPollInFlight(held);

      const disposing = watcher().dispose();
      await bootstrapper.bootstrap();
      held.release();
      await disposing;
      await held.ended();

      expect(held.set.called).to.equal(false);
      expect(held.changed.called).to.equal(false);
    } finally {
      held.restore();
    }
  });

  it('settles a second dispose() with the first, both only once the poll in flight ended', async () => {
    const held = await heldPoll();
    try {
      await timerWithPollInFlight(held);

      const settled: string[] = [];
      const first = watcher().dispose().then(() => settled.push('first'));
      const second = watcher().dispose().then(() => settled.push('second'));
      await clock.tickAsync(0);
      expect(settled, 'neither settles while the poll runs').to.deep.equal([]);

      held.release();
      await Promise.all([first, second]);

      expect(settled).to.have.members(['first', 'second']);
      expect(held.set.called).to.equal(false);
    } finally {
      held.restore();
    }
  });

  it('polls and applies on a refreshWatched() called after the watcher was disposed', async () => {
    const held = await heldPoll();
    try {
      internals(bootstrapper).startWatchTimer(containerOf(false, held.configuration).container);
      await watcher().dispose();

      const manual = bootstrapper.refreshWatched();
      held.release();
      await manual;

      expect(held.set.calledOnceWith(ROW.Slug, ROW.Value)).to.equal(true);
      expect(held.changed.calledOnce).to.equal(true);
    } finally {
      held.restore();
    }
  });

  it('ends a poll started by hand after the watcher was disposed when the container is disposed', async () => {
    const held = await heldPoll();
    try {
      internals(bootstrapper).startWatchTimer(containerOf(false, held.configuration).container);
      await watcher().dispose();

      const manual = bootstrapper.refreshWatched();
      const disposing = child.dispose();
      await clock.tickAsync(0);
      held.release();
      await Promise.all([manual, disposing]);

      expect(held.set.called).to.equal(false);
      expect(held.changed.called).to.equal(false);
    } finally {
      held.restore();
    }
  });

  it('ends a poll started by hand after a new bootstrap() that kept the running watcher, when the container is disposed', async () => {
    const held = await heldPoll();
    try {
      internals(bootstrapper).startWatchTimer(containerOf(false, held.configuration).container);
      await bootstrapper.bootstrap();

      const manual = bootstrapper.refreshWatched();
      const disposing = child.dispose();
      await clock.tickAsync(0);
      held.release();
      await Promise.all([manual, disposing]);

      expect(held.set.called).to.equal(false);
      expect(held.changed.called).to.equal(false);
    } finally {
      held.restore();
    }
  });

  it('ends a poll started by hand before any watcher existed, when the container that holds the Orm is disposed', async () => {
    const held = await heldPoll();
    const root = DI.RootContainer;
    const { orm } = containerOf(false);
    // the root container holds the Orm but no watcher yet; its services resolve in the child, which the test disposes
    const get = sinon.stub(root, 'get').callsFake((key: unknown) => (key === Orm ? orm : child.get(key as typeof DbConfigWatcher)));
    const resolve = sinon.stub(root, 'resolve').callsFake(((key: typeof DbConfigWatcher) => child.resolve(key)) as typeof root.resolve);
    try {
      (bootstrapper as unknown as { configuration: unknown }).configuration = held.configuration;

      const manual = bootstrapper.refreshWatched();
      expect(child.get(DbConfigWatcher), 'the poll resolved a watcher').to.be.instanceOf(DbConfigWatcher);
      const disposing = child.dispose();
      await clock.tickAsync(0);
      held.release();
      await Promise.all([manual, disposing]);

      expect(held.set.called).to.equal(false);
      expect(held.changed.called).to.equal(false);
    } finally {
      get.restore();
      resolve.restore();
      held.restore();
    }
  });

  it('starts no timer when a migration signal sweeps after the watcher was disposed, and still writes the rows', async () => {
    await bootstrapper.bootstrap();
    internals(bootstrapper).startWatchTimer(containerOf(false).container);
    await watcher().dispose();

    await migrationSignal();
    await clock.tickAsync(interval * 2);

    expect((internals(bootstrapper).saveConfigOptions as sinon.SinonStub).callCount, 'the signal swept').to.equal(1);
    expect(polls.callCount).to.equal(0);
  });

  it('watches again with a fresh watcher after a new bootstrap(), with no signal after bootstrap()', async () => {
    await bootstrapper.bootstrap();
    await migrationSignal();
    const disposed = watcher();
    await disposed.dispose();

    await bootstrapper.bootstrap();
    await bootstrapper.whenSwept();
    await clock.tickAsync(interval);

    expect(watcher()).to.not.equal(disposed);
    expect(isWatchDisposed(watcher())).to.equal(false);
    expect(polls.callCount).to.equal(1);
  });

  it('watches again after a new bootstrap() with a watcher registered as DbConfigWatcher', async () => {
    child.register(ReplacedWatcher).as(DbConfigWatcher);
    await bootstrapper.bootstrap();
    await migrationSignal();
    const disposed = child.resolve(DbConfigWatcher);
    expect(disposed).to.be.instanceOf(ReplacedWatcher);
    await disposed.dispose();

    await bootstrapper.bootstrap();
    await bootstrapper.whenSwept();
    await clock.tickAsync(interval);

    const fresh = child.resolve(DbConfigWatcher);
    expect(fresh).to.be.instanceOf(ReplacedWatcher);
    expect(fresh).to.not.equal(disposed);
    expect(polls.callCount).to.equal(1);
  });

  it('sweeps and starts the watch from the first bootstrap() when the root already holds an Orm, with no signal', async () => {
    const saves = sinon.stub().resolves();
    internals(bootstrapper).saveConfigOptions = saves;
    const app = containerOf(true);
    const root = DI.RootContainer;
    // the root reports a cached Orm before the first bootstrap(); its services resolve in the child the test disposes
    const get = sinon.stub(root, 'get').callsFake((key: unknown) => app.container.get(key as typeof DbConfigWatcher));
    const resolve = sinon.stub(root, 'resolve').callsFake(((key: typeof DbConfigWatcher) => child.resolve(key)) as typeof root.resolve);
    try {
      await bootstrapper.bootstrap();
      await bootstrapper.whenSwept();
      await clock.tickAsync(interval);

      expect(saves.callCount, 'the exposed options were written').to.equal(1);
      expect(polls.callCount, 'the watch polled').to.equal(1);
    } finally {
      get.restore();
      resolve.restore();
    }
  });

  it('looks in the root again after the container that held the watcher was disposed', async () => {
    await bootstrapper.bootstrap();
    await migrationSignal();
    await child.dispose();

    await bootstrapper.bootstrap();
    await bootstrapper.whenSwept();
    await clock.tickAsync(interval * 2);

    expect(polls.callCount, 'no timer started in the disposed container').to.equal(0);
  });

  it('lets a replacing timer wait for the poll in flight of the timer it replaced', async () => {
    let finish: () => void = () => undefined;
    polls.onFirstCall().callsFake(() => new Promise<void>((resolve) => (finish = resolve)));
    internals(bootstrapper).startWatchTimer(containerOf(false).container);
    await clock.tickAsync(interval);

    internals(bootstrapper).startWatchTimer(containerOf(false).container);
    await clock.tickAsync(interval * 2);
    expect(polls.callCount, 'the new timer waits for the poll in flight').to.equal(1);

    finish();
    await clock.tickAsync(interval);

    expect(polls.callCount).to.equal(2);
  });

  it('runs one timer after a failed sweep is followed by another sweep', async () => {
    internals(bootstrapper).saveConfigOptions = () => Promise.reject(new Error('no such table: configuration'));
    const { container } = containerOf(false);

    const error = sinon.stub(InternalLogger, 'error');
    try {
      await internals(bootstrapper).syncExposedOptions(container);
      await internals(bootstrapper).syncExposedOptions(container);
    } finally {
      error.restore();
    }

    await clock.tickAsync(interval);

    expect(polls.callCount).to.equal(1);
  });

  it('a disposed watcher starts no timer, and dispose() can be called twice', async () => {
    const fresh = child.resolve(DbConfigWatcher);
    await fresh.dispose();
    await fresh.dispose();

    const poll = sinon.stub().resolves();
    startWatch(fresh, poll, interval);
    await clock.tickAsync(interval * 2);

    expect(poll.called).to.equal(false);
  });
});
