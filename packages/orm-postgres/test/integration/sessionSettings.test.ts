import * as chai from 'chai';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';

import { DI } from '@spinajs/di';
import { ConnectionSessionSettings } from '@spinajs/orm';

import { IPgSuite, openSuite } from './harness.js';

const expect = chai.expect;

const scope = new AsyncLocalStorage<Record<string, string>>();

class ScopedSettings extends ConnectionSessionSettings {
  static calls = 0;
  async settings(): Promise<Readonly<Record<string, string>> | undefined> {
    ScopedSettings.calls++;
    return scope.getStore();
  }
}

describe('postgres integration - ConnectionSessionSettings', function () {
  let suite: IPgSuite;

  before(async function () {
    // one connection: a setting that outlived its statement would show on the next one
    suite = await openSuite(this, { name: 'session', pool: { Max: 1 } });
    DI.register(ScopedSettings).as(ConnectionSessionSettings);
  });

  after(async () => {
    DI.unregister(ScopedSettings);
    DI.uncache(ConnectionSessionSettings);
    await suite?.close();
  });

  const read = async (): Promise<unknown> => (await suite.raw<{ v: unknown }[]>("SELECT current_setting('spina.test', true) AS v"))[0].v;

  it('sets the settings on a statement outside a transaction, for that statement only', async () => {
    expect(await scope.run({ 'spina.test': 'lone' }, read)).to.equal('lone');
    expect(await read()).to.be.oneOf(['', null]);
  });

  it('sets them once at BEGIN for every statement of a transaction', async () => {
    ScopedSettings.calls = 0;
    const seen = await scope.run({ 'spina.test': 'tx' }, () => suite.driver.transaction(async () => [await read(), await read()]));
    expect(seen).to.deep.equal(['tx', 'tx']);
    // BEGIN asks once; the statements inside reuse the transaction's connection.
    expect(ScopedSettings.calls).to.equal(1);
    expect(await read()).to.be.oneOf(['', null]);
  });

  it('rolls the wrapping transaction back when the statement fails', async () => {
    let failed = false;
    await scope.run({ 'spina.test': 'x' }, () => suite.raw('SELECT 1/0')).catch(() => (failed = true));
    expect(failed).to.equal(true);
    expect(await read()).to.be.oneOf(['', null]);
  });
});
