import 'mocha';
import { expect } from 'chai';
import { existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DI } from '@spinajs/di';
import { Clock, DbClock, FaultInjector } from '@spinajs/durable';
import { createEnv, ensure, invariant, resolveOptions, runInContext, simulate, SimCrash, type MutableSimEnv } from '../src/index.js';
import './support/probe-migration.js';

const newEnv = (seed: number): MutableSimEnv => createEnv(resolveOptions({ seed, steps: 0, faults: [], suite: 'db-test' }));

describe('SimDatabase and SimEnv.boot', () => {
  let env: MutableSimEnv;

  beforeEach(() => {
    env = newEnv(9001);
  });

  afterEach(async () => {
    await env.shutdown(false);
  });

  const boot = (template?: string) => env.boot({ config: {}, aliases: ['simprobe'], template });
  const notes = async (): Promise<string[]> => (await env.database.driver.select<Array<{ Note: string }>>().from('sim_probe')).map((r) => r.Note);
  const insert = async (note: string): Promise<void> => {
    await env.database.driver.insert().into('sim_probe').values({ Note: note });
  };
  const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

  it('opens one sqlite file per seed and runs the migrations of aliased connections on it', async () => {
    await boot();
    expect(env.database.file).to.match(/spinajs-sim-9001[\\/]sim\.sqlite$/);
    expect(existsSync(env.database.file)).to.equal(true);
    expect(env.database.migratedFrom).to.equal('migrations');
    expect(await notes()).to.deep.equal([]);
  });

  it('binds Clock, DbTimeSource and FaultInjector to the simulated instances', async () => {
    await boot();
    expect(await DI.resolve(Clock)).to.equal(env.clock);
    expect(await DI.resolve(FaultInjector)).to.equal(env.faults);
    env.clock.advance(5_000);
    const dbClock = await DI.resolve(DbClock);
    expect(await dbClock.sync()).to.equal(env.clock.now());
    expect(dbClock.offset).to.equal(0);
  });

  it('rejects every statement of a dead incarnation', async () => {
    await boot();
    const ctx = env.replicas.context('r1');
    env.replicas.crash(ctx);
    expect(await rejection(runInContext(ctx, () => insert('ghost')))).to.be.instanceOf(SimCrash);
    expect(await notes()).to.deep.equal([]);
  });

  it('turns the COMMIT of an incarnation that died inside its transaction into a ROLLBACK', async () => {
    await boot();
    const ctx = env.replicas.context('r1');
    await runInContext(ctx, () =>
      env.database.driver.transaction(async () => {
        await insert('lost');
        env.replicas.crash(ctx);
      }),
    );
    expect(await notes()).to.deep.equal([]);
  });

  it('commits the transaction of a live incarnation', async () => {
    await boot();
    await runInContext(env.replicas.context('r1'), () => env.database.driver.transaction(() => insert('kept')));
    expect(await notes()).to.deep.equal(['kept']);
  });

  it('defers a pause inside a transaction until the outermost transaction has ended', async () => {
    await boot();
    const ctx = env.replicas.context('r1');
    const before = env.clock.now();
    let frozenInside: boolean | undefined;
    const flight = runInContext(ctx, () =>
      env.database.driver.transaction(async () => {
        await insert('slow');
        await env.park(5_000);
        frozenInside = env.replicas.isFrozen('r1');
      }),
    );
    await env.settle();
    expect(frozenInside).to.equal(false);
    expect(env.clock.now()).to.equal(before);
    expect(env.replicas.isFrozen('r1')).to.equal(true);
    expect(env.replicas.due(before + 5_000)).to.deep.equal(['r1']);
    expect(await notes()).to.deep.equal(['slow']);
    env.replicas.thaw('r1');
    await flight;
    expect(env.replicas.isFrozen('r1')).to.equal(false);
  });

  it('settles only once no statement is in flight', async () => {
    await boot();
    const pending = insert('later');
    await env.settle();
    expect(await notes()).to.deep.equal(['later']);
    await pending;
  });

  it('copies a migrated template for the next seed of the same key', async () => {
    await boot('probe');
    expect(env.database.migratedFrom).to.equal('migrations');
    await env.shutdown(false);
    env = newEnv(9002);
    await boot('probe');
    expect(env.database.migratedFrom).to.equal('template');
    await insert('from-template');
    expect(await notes()).to.deep.equal(['from-template']);
  });

  it('deletes the database after a pass and keeps it after a failure', async () => {
    await boot();
    const kept = await env.shutdown(true);
    expect(kept).to.equal(env.database.file);
    expect(existsSync(kept!)).to.equal(true);
  });

  it('reports the kept database file of a failing seed', async () => {
    const report = await simulate(
      async (e) => {
        await e.boot({ config: {}, aliases: ['simprobe'] });
        return { actors: [], invariants: [invariant('always-fails', async () => ensure(false, 'broken on purpose'))], workload: () => Promise.resolve(), dispose: () => Promise.resolve() };
      },
      { seed: 9003, steps: 10, faults: [], suite: 'db-test' },
    );
    expect(report.failure?.invariant).to.equal('always-fails');
    expect(existsSync(report.databaseFile!)).to.equal(true);
    rmSync(dirname(report.databaseFile!), { recursive: true, force: true });
  });
});
