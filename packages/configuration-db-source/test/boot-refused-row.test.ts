import { expect } from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike } from '@spinajs/configuration';
import { InternalLogger } from '@spinajs/internal-logger';
import { testHost } from '@spinajs/authz-testing';

import { ConfiguratioDbSource, DbConfig } from '../src/index.js';
import { bootDb, DbHandle } from './support/db.js';

const SCHEMAS = [
  {
    $id: 'test-boot-refused-limits',
    $configurationModule: 'bootRefused',
    type: 'object',
    properties: { limit: { type: 'number', maximum: 25 }, title: { type: 'string' } },
  },
  {
    $id: 'test-boot-refused-range',
    $configurationModule: 'bootRange',
    type: 'object',
    properties: { min: { type: 'number' }, max: { type: 'number', minimum: { $data: '1/min' } } },
  },
  {
    $id: 'test-boot-refused-late',
    $configurationModule: 'bootLate',
    type: 'object',
    required: ['key'],
    properties: { key: { type: 'string' }, extra: { type: 'number' } },
  },
];

// inserted in this order, so the table returns them in it
const ROWS = [
  { Slug: 'bootRefused.limit', Value: '30', Type: 'number' },
  { Slug: 'bootRefused.title', Value: 'from db', Type: 'string' },
  { Slug: 'bootRange.min', Value: '30', Type: 'number' },
  { Slug: 'bootRange.max', Value: '40', Type: 'number' },
  { Slug: 'bootLate.extra', Value: '5', Type: 'number' },
  { Slug: 'bootFree.anything', Value: '99', Type: 'number' },
];

class FileLikeSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({
      db: { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }] },
      bootRefused: { limit: 20, title: 'from file' },
      bootRange: { min: 10, max: 20 },
    } as IConfigLike);
  }
}

class BootConfiguration extends FrameworkConfiguration {
  protected loadSources(): void {
    this.Sources = [new FileLikeSource(), this.Container.resolve(ConfiguratioDbSource)];
  }

  protected onLoad(): unknown {
    // a required key that arrives after the sources ran
    return { bootLate: { key: 'from onLoad' } };
  }
}

describe('boot with a stored row the configuration refuses', function () {
  this.timeout(10000);

  let db: DbHandle;
  let child: IContainer;
  let config: Configuration;
  let refusals: { slug: string; violation: string; message: string }[];
  let bootError: Error | undefined;

  before(async () => {
    await testHost.installHost();
    db = await bootDb((path, value) => testHost.config().set([...path], value));

    await DbConfig.destroy().whereIn(
      'Slug',
      ROWS.map((r) => r.Slug),
    );
    for (const r of ROWS) {
      await DbConfig.insert({ ...r, Group: 'test', Exposed: true });
    }

    child = DI.child();
    for (const s of SCHEMAS) child.register(s).asValue('__configurationSchema__');
    child.register(BootConfiguration).as(Configuration);

    const error = sinon.stub(InternalLogger, 'error');
    try {
      config = await child.resolve(Configuration);
    } catch (e) {
      bootError = e as Error;
    } finally {
      error.restore();
    }

    refusals = error
      .getCalls()
      .filter((c) => c.args[2] === 'configuration-db-source')
      .map((c) => ({ ...(c.args[0] as { slug: string; violation: string }), message: c.args[1] }));
  });

  after(async () => {
    await child?.dispose();
    await db.dispose();
    testHost.config().reset();
    await testHost.uninstallHost();
  });

  const refusedSlugs = () => refusals.map((r) => r.slug);

  const booted = () => {
    expect(bootError?.message, 'the boot failed').to.be.undefined;
    return config;
  };

  it('boots on the file value, applies the other rows and names the refused row', () => {
    expect(booted().get('bootRefused.limit')).to.equal(20);
    expect(config.get('bootRefused.title')).to.equal('from db');
    expect(config.get('bootFree.anything')).to.equal(99);

    const limit = refusals.filter((r) => r.slug === 'bootRefused.limit');
    expect(limit).to.have.length(1);
    expect(limit[0].message).to.equal('configuration row ${slug} refused: ${violation}');
    expect(limit[0].violation).to.equal('bootRefused.limit must be <= 25');
  });

  it('skips the first of two rows that are valid only together', () => {
    expect(booted().get('bootRange.min')).to.equal(10);
    expect(config.get('bootRange.max')).to.equal(40);
    expect(refusedSlugs()).to.include('bootRange.min');
    expect(refusedSlugs()).to.not.include('bootRange.max');
  });

  it('does not refuse a row for a violation the configuration had without it', () => {
    expect(booted().get('bootLate.extra')).to.equal(5);
    expect(config.get('bootLate.key')).to.equal('from onLoad');
    expect(refusedSlugs()).to.not.include('bootLate.extra');
  });

  it('refuses nothing else', () => {
    booted();
    expect(refusedSlugs()).to.have.members(['bootRefused.limit', 'bootRange.min']);
  });
});
