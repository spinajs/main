import { expect } from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike } from '@spinajs/configuration';
import { InternalLogger } from '@spinajs/internal-logger';
import { testHost } from '@spinajs/authz-testing';

import { CONFIGURATION_DB_CHANGED_EVENT, DbConfig, DbConfigSourceBotstrapper, DbConfigValueConverter } from '../src/index.js';
import { bootDb, DbHandle } from './support/db.js';

const HOST = 'watchedChanged.host';
const PORT = 'watchedChanged.port';
const LIMIT = 'watchedChanged.limit';

const SCHEMA = {
  $id: 'test-watched-changed-event',
  $configurationModule: 'watchedChanged',
  type: 'object',
  properties: { host: { type: 'string' }, port: { type: 'string' }, limit: { type: 'number', maximum: 25 } },
};

type Change = [slug: unknown, previous: unknown, next: unknown];

class NoSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
}

class PolledConfiguration extends FrameworkConfiguration {
  protected loadSources(): void {
    this.Sources = [];
  }

  protected onLoad(): unknown {
    return { watchedChanged: { host: 'old-host', port: 'old-port', limit: 20 } };
  }
}

describe('event after a watched value changed', function () {
  this.timeout(10000);

  let db: DbHandle;
  let child: IContainer;
  let config: Configuration;
  let bootstrapper: DbConfigSourceBotstrapper;
  let changes: Change[];
  let listeners: Array<(...args: unknown[]) => void>;

  const listen = (listener: (...args: unknown[]) => void) => {
    DI.on(CONFIGURATION_DB_CHANGED_EVENT, listener);
    listeners.push(listener);
  };
  const capture = (slug: unknown, previous: unknown, next: unknown) => {
    changes.push([slug, previous, next]);
  };

  before(async () => {
    await testHost.installHost();
    db = await bootDb((path, value) => testHost.config().set([...path], value));

    child = DI.child();
    child.register(SCHEMA).asValue('__configurationSchema__');
    child.register(NoSource).as(ConfigurationSource);
    child.register(PolledConfiguration).as(Configuration);
    config = await child.resolve(Configuration);
  });

  beforeEach(async () => {
    await DbConfig.destroy().whereIn('Slug', [HOST, PORT, LIMIT]);
    config.set('watchedChanged', { host: 'old-host', port: 'old-port', limit: 20 });
    await db.seed([
      { path: HOST, value: 'new-host' },
      { path: PORT, value: 'new-port' },
    ]);

    bootstrapper = new DbConfigSourceBotstrapper();
    const internals = bootstrapper as unknown as { Converter: DbConfigValueConverter; configuration: Configuration };
    internals.Converter = await DI.resolve(DbConfigValueConverter);
    internals.configuration = config;

    changes = [];
    listeners = [];
  });

  afterEach(() => {
    listeners.forEach((l) => DI.off(CONFIGURATION_DB_CHANGED_EVENT, l));
  });

  after(async () => {
    await child.dispose();
    await db.dispose();
    testHost.config().reset();
    await testHost.uninstallHost();
  });

  it('is raised once per changed row with the slug, the previous and the next value', async () => {
    listen(capture);

    await bootstrapper.refreshWatched();

    expect(changes).to.have.deep.members([
      [HOST, 'old-host', 'new-host'],
      [PORT, 'old-port', 'new-port'],
    ]);
  });

  it('is not raised by a poll that finds nothing changed', async () => {
    await bootstrapper.refreshWatched();
    listen(capture);

    await bootstrapper.refreshWatched();

    expect(changes).to.deep.equal([]);
  });

  it('is not raised for a row the configuration refuses, while the other rows raise it', async () => {
    await DbConfig.insert({ Slug: LIMIT, Value: '30', Group: 'test', Type: 'number', Watch: true, Exposed: true });
    listen(capture);

    const error = sinon.stub(InternalLogger, 'error');
    try {
      await bootstrapper.refreshWatched();
    } finally {
      error.restore();
    }

    expect(config.get(LIMIT)).to.equal(20);
    expect(changes.map(([slug]) => slug)).to.have.members([HOST, PORT]);
  });

  it("is not raised by the application's own Configuration.set()", () => {
    listen(capture);

    config.set(HOST, 'set-by-the-app');

    expect(changes).to.deep.equal([]);
  });

  it('logs a listener that throws, and the poll still applies the other rows and raises their events', async () => {
    listen((slug: unknown) => {
      if (slug === HOST) {
        throw new Error('listener failed');
      }
    });
    listen(capture);

    const error = sinon.stub(InternalLogger, 'error');
    try {
      await bootstrapper.refreshWatched();

      expect(config.get(HOST)).to.equal('new-host');
      expect(config.get(PORT)).to.equal('new-port');
      expect(changes).to.deep.equal([[PORT, 'old-port', 'new-port']]);

      const failures = error.getCalls().filter((c) => (c.args[0] as { slug?: string }).slug === HOST);
      expect(failures).to.have.length(1);
      expect(failures[0].args[1]).to.contain(CONFIGURATION_DB_CHANGED_EVENT);
    } finally {
      error.restore();
    }
  });
});
