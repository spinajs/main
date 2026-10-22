// Ends every test with DI.dispose(), which drops the module-level @Config registrations: named to run after the other suites.
import { expect } from 'chai';
import 'mocha';
import { DI, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import '@spinajs/log';

import { DbConfigSourceBotstrapper } from './../src/index.js';

const EVENTS = ['di.registered.__configuration_property__', 'di.resolved.Orm', 'di.resolved.OrmMigrator'];

/** The private members these tests drive: the sweep and its inputs. */
interface Internals {
  tableReady: boolean;
  syncExposedOptions(container: IContainer): void;
  saveConfigOptions(v: unknown): Promise<void>;
}

const internals = (b: DbConfigSourceBotstrapper) => b as unknown as Internals;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A container holding one exposed option and an Orm whose `configuration` table does not exist. */
function containerWithoutTable(): IContainer {
  const orm = {
    Connections: new Map([['default', { AwaitsStartupMigration: false, schema: () => ({ tableExists: async () => false }) }]]),
  };
  const vars = [{ path: 'swept', options: { expose: true, exposeOptions: { type: 'string', group: 'g' } } }];

  return {
    get: (key: unknown) => (key === Orm ? orm : key === Configuration ? { get: () => undefined, set: () => undefined } : vars),
  } as unknown as IContainer;
}

describe('DbConfigSourceBotstrapper signals', function () {
  this.timeout(10000);

  let bootstrapper: DbConfigSourceBotstrapper;
  let swept: IContainer[];

  beforeEach(async () => {
    bootstrapper = new DbConfigSourceBotstrapper();
    swept = [];
    internals(bootstrapper).syncExposedOptions = (container: IContainer) => {
      swept.push(container);
    };
    await bootstrapper.bootstrap();
  });

  afterEach(async () => {
    await DI.dispose();
  });

  it('sweeps nothing for a migrator resolved with MigrateOnStartup: false; it created no table', () => {
    DI.emit('di.resolved.OrmMigrator', DI.RootContainer, { MigrateOnStartup: false });
    expect(swept).to.have.length(0);

    DI.emit('di.resolved.OrmMigrator', DI.RootContainer, { MigrateOnStartup: true });
    expect(swept).to.have.length(1);
  });

  it('removes the DI listeners it added once the container is disposed', async () => {
    const second = new DbConfigSourceBotstrapper();
    const counts = () => EVENTS.map((e) => DI.listenerCount(e));
    const bootstrapped = counts();

    await DI.dispose();
    const disposed = counts();

    await second.bootstrap();
    expect(counts(), 'a bootstrap adds one listener per signal').to.eql(disposed.map((n) => n + 1));
    expect(disposed.every((n, i) => n < bootstrapped[i]), 'dispose removed the listeners of the first bootstrap').to.equal(true);
  });
});

describe('DbConfigSourceBotstrapper failed sweep', function () {
  this.timeout(10000);

  afterEach(async () => {
    await DI.dispose();
  });

  it('asks the database again after a failed sweep, and sweeps on the next signal', async () => {
    const bootstrapper = new DbConfigSourceBotstrapper();
    let saves = 0;
    internals(bootstrapper).saveConfigOptions = async () => {
      saves++;
      throw new Error('no such table: configuration');
    };

    const container = containerWithoutTable();
    internals(bootstrapper).syncExposedOptions(container);
    await wait(50);

    expect(internals(bootstrapper).tableReady, 'the table the failed sweep wrote to does not exist').to.equal(false);

    internals(bootstrapper).syncExposedOptions(container);
    await wait(50);

    expect(saves).to.equal(2);
  });
});
