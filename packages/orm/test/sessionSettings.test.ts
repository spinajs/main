import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';

import { DI, IContainer } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';

import { OrmDriver } from '../src/driver.js';
import { Builder, SessionSettingsQueryBuilder } from '../src/builders.js';
import { ICompilerOutput, IColumnDescriptor, ISupportedFeature, ITransactionContext, SessionSettingsQueryCompiler } from '../src/interfaces.js';
import { ConnectionSessionSettings } from '../src/session-settings.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const scope = new AsyncLocalStorage<Record<string, string>>();

class ScopedSettings extends ConnectionSessionSettings {
  static calls = 0;
  async settings(): Promise<Readonly<Record<string, string>> | undefined> {
    ScopedSettings.calls++;
    return scope.getStore();
  }
}

const log: string[] = [];

class LoggingCompiler extends SessionSettingsQueryCompiler {
  constructor(protected builder: SessionSettingsQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    log.push(`compile ${JSON.stringify(this.builder.Settings)}`);
    return { expression: 'SET', bindings: [] };
  }
}

class RefusingCompiler extends SessionSettingsQueryCompiler {
  public compile(): ICompilerOutput {
    throw new NotSupported('no session settings');
  }
}

class SettingsDriver extends OrmDriver {
  constructor(container: IContainer) {
    super({} as any);
    this.Container = container;
  }

  public async execute(builder: Builder<any>): Promise<any> {
    log.push(builder instanceof SessionSettingsQueryBuilder ? 'apply' : 'execute');
    return [];
  }

  /** Stands in for a driver's executeOnDb. */
  public statement(): Promise<string> {
    return this.withSessionSettings(async () => {
      log.push(this.CurrentTransaction === undefined ? 'statement' : 'statement in transaction');
      return 'done';
    });
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public supportedFeatures(): ISupportedFeature {
    return { events: false, insertReturning: false };
  }

  public async tableInfo(): Promise<IColumnDescriptor[]> {
    return [];
  }

  protected async _begin(): Promise<ITransactionContext> {
    log.push('begin');
    return { depth: 0 };
  }

  protected async _commit(): Promise<void> {
    log.push('commit');
  }

  protected async _rollback(): Promise<void> {
    log.push('rollback');
  }

  protected async _savepoint(): Promise<void> {}

  protected async _releaseSavepoint(): Promise<void> {}

  protected async _rollbackToSavepoint(): Promise<void> {}

  protected async _dispose(): Promise<void> {}
}

describe('OrmDriver - session settings', () => {
  let container: IContainer;
  let driver: SettingsDriver;

  beforeEach(() => {
    log.length = 0;
    ScopedSettings.calls = 0;
    container = DI.child();
    container.register(LoggingCompiler).as(SessionSettingsQueryCompiler);
    container.register(ScopedSettings).as(ConnectionSessionSettings);
    driver = new SettingsDriver(container);
  });

  it('applies the settings right after BEGIN, compiled before it', async () => {
    await scope.run({ a: '1' }, () => driver.transaction(() => driver.statement()));
    expect(log).to.deep.equal(['compile {"a":"1"}', 'begin', 'apply', 'statement in transaction', 'commit']);
    expect(ScopedSettings.calls).to.equal(1);
  });

  it('runs a statement outside a transaction in one of its own when settings apply', async () => {
    expect(await scope.run({ a: '1' }, () => driver.statement())).to.equal('done');
    expect(log).to.deep.equal(['compile {"a":"1"}', 'begin', 'apply', 'statement in transaction', 'commit']);
    expect(ScopedSettings.calls).to.equal(1);
  });

  it('leaves a statement alone when no provider has settings', async () => {
    await driver.statement();
    await driver.transaction(() => driver.statement());
    expect(log).to.deep.equal(['statement', 'begin', 'statement in transaction', 'commit']);
  });

  it('merges providers, the later one winning', async () => {
    class Later extends ConnectionSessionSettings {
      async settings() {
        return { a: '2', b: '3' };
      }
    }
    container.register(Later).as(ConnectionSessionSettings);
    await scope.run({ a: '1' }, () => driver.statement());
    expect(log[0]).to.equal('compile {"a":"2","b":"3"}');
  });

  it('throws NotSupported before BEGIN on a dialect without session settings', async () => {
    container.register(RefusingCompiler).as(SessionSettingsQueryCompiler);
    await expect(scope.run({ a: '1' }, () => driver.statement())).to.be.rejectedWith(NotSupported);
    await expect(scope.run({ a: '1' }, () => driver.transaction(() => driver.statement()))).to.be.rejectedWith(NotSupported);
    expect(log).to.deep.equal([]);
  });
});
