import { expect } from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike } from '@spinajs/configuration';
import { InternalLogger } from '@spinajs/internal-logger';
import { testHost } from '@spinajs/authz-testing';

import { DbConfig, DbConfigSourceBotstrapper } from '../src/index.js';
import { bootDb, DbHandle } from './support/db.js';

const LIMIT = 'pollRefused.limit';
const TITLE = 'pollRefused.title';

const SCHEMA = {
  $id: 'test-poll-refused-row',
  $configurationModule: 'pollRefused',
  type: 'object',
  properties: { limit: { type: 'number', maximum: 25 }, title: { type: 'string' } },
};

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
    return { pollRefused: { limit: 20, title: 'old' } };
  }
}

describe('watch poll with a row the configuration refuses', function () {
  this.timeout(10000);

  let db: DbHandle;
  let child: IContainer;
  let config: Configuration;
  let bootstrapper: DbConfigSourceBotstrapper;
  let error: sinon.SinonStub;

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
    error = sinon.stub(InternalLogger, 'error');

    await DbConfig.destroy().whereIn('Slug', [LIMIT, TITLE]);
    config.set('pollRefused', { limit: 20, title: 'old' });

    // the refused row first by id and by slug, so the poll reaches it before the valid one
    await DbConfig.insert({ Slug: LIMIT, Value: '30', Group: 'test', Type: 'number', Watch: true, Exposed: true });
    await DbConfig.insert({ Slug: TITLE, Value: 'new', Group: 'test', Type: 'string', Watch: true, Exposed: true });

    bootstrapper = new DbConfigSourceBotstrapper();
    const internals = bootstrapper as unknown as { configuration: Configuration; watchedSlugs: Set<string> };
    internals.configuration = config;
    internals.watchedSlugs.add(LIMIT).add(TITLE);
  });

  afterEach(() => {
    error.restore();
  });

  after(async () => {
    await child.dispose();
    await db.dispose();
    testHost.config().reset();
    await testHost.uninstallHost();
  });

  const logged = () => error.getCalls().filter((c) => c.args[2] === 'configuration-db-source');
  const refusals = () => logged().filter((c) => (c.args[0] as { slug?: string }).slug === LIMIT);
  const invalid = () => error.getCalls().filter((c) => c.args[2] === 'Configuration');

  it('applies the other watched rows and keeps the previous value of the refused one', async () => {
    await bootstrapper.refreshWatched();

    expect(config.get(TITLE)).to.equal('new');
    expect(config.get(LIMIT)).to.equal(20);
  });

  it('logs a refusal once, naming the slug, however many ticks see it', async () => {
    await bootstrapper.refreshWatched();
    await bootstrapper.refreshWatched();
    await bootstrapper.refreshWatched();

    expect(refusals()).to.have.length(1);
    expect(refusals()[0].args[1]).to.contain('${slug}');
    expect(logged(), 'the poll itself did not fail').to.have.length(1);
  });

  it('does not try an unchanged refused row again, so Configuration logs it once', async () => {
    await bootstrapper.refreshWatched();
    await bootstrapper.refreshWatched();
    await bootstrapper.refreshWatched();

    expect(invalid()).to.have.length(1);
    expect(invalid()[0].args[0]).to.include({ path: LIMIT });
  });

  it('tries a refused row again once its value changed', async () => {
    await bootstrapper.refreshWatched();

    await DbConfig.update({ Value: '40' }).where('Slug', LIMIT);
    await bootstrapper.refreshWatched();
    await bootstrapper.refreshWatched();
    expect(invalid()).to.have.length(2);
    expect(config.get(LIMIT)).to.equal(20);

    await DbConfig.update({ Value: '25' }).where('Slug', LIMIT);
    await bootstrapper.refreshWatched();
    expect(config.get(LIMIT)).to.equal(25);
  });

  it('logs the refusal again once the row was applied in between', async () => {
    await bootstrapper.refreshWatched();

    await DbConfig.update({ Value: '24' }).where('Slug', LIMIT);
    await bootstrapper.refreshWatched();
    expect(config.get(LIMIT)).to.equal(24);

    await DbConfig.update({ Value: '30' }).where('Slug', LIMIT);
    await bootstrapper.refreshWatched();

    expect(config.get(LIMIT)).to.equal(24);
    expect(refusals()).to.have.length(2);
  });
});
