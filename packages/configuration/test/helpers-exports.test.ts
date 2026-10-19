import 'mocha';
import { expect } from 'chai';
import { join, resolve } from 'path';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { bindConfigurationContainer, Config, merge, mergeArrays, packageLibDirs } from '../src/index.js';
import { configurationOf, NoSource } from './fixtures.js';

describe('packageLibDirs', () => {
  const saved = process.env.WORKSPACE_ROOT_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.WORKSPACE_ROOT_PATH;
    else process.env.WORKSPACE_ROOT_PATH = saved;
  });

  const flavour = typeof module !== 'undefined' ? 'cjs' : 'mjs';

  it('points at the package build under the working directory, then one level up', () => {
    delete process.env.WORKSPACE_ROOT_PATH;
    expect(packageLibDirs('@spinajs/authn-token', 'cli')).to.deep.equal([
      resolve(process.cwd(), 'node_modules', '@spinajs', 'authn-token', 'lib', flavour, 'cli'),
      resolve(process.cwd(), '..', 'node_modules', '@spinajs', 'authn-token', 'lib', flavour, 'cli'),
    ]);
  });

  it('roots at WORKSPACE_ROOT_PATH when set', () => {
    process.env.WORKSPACE_ROOT_PATH = join(process.cwd(), 'ws');
    expect(packageLibDirs('@spinajs/authz-rbac', 'cli/commands')[0]).to.equal(resolve(process.cwd(), 'ws', 'node_modules', '@spinajs', 'authz-rbac', 'lib', flavour, 'cli', 'commands'));
  });
});

describe('merge exports', () => {
  it('mergeArrays concatenates arrays for lodash mergeWith', () => {
    expect(mergeArrays([1], [2])).to.deep.equal([1, 2]);
    expect(mergeArrays(undefined as unknown as unknown[], [2])).to.equal(undefined);
  });

  it('merge unions arrays and merges objects in place', () => {
    const to = { a: [1, 2], b: { c: 1 } };
    expect(merge(to, { a: [2, 3], b: { d: 2 } })).to.deep.equal({ a: [1, 2, 3], b: { c: 1, d: 2 } });
  });
});

describe('bindConfigurationContainer', () => {
  class Reader {
    @Config('reader.value')
    public Value: string;
  }

  let c: IContainer;
  beforeEach(async () => {
    c = DI.RootContainer.child();
    c.register(NoSource).as(ConfigurationSource);
    c.register(configurationOf({ reader: { value: 'child' } })).as(Configuration);
    await c.resolve(Configuration);
  });
  afterEach(async () => c.dispose());

  it('makes @Config of an instance built with new read the bound container', () => {
    const reader = bindConfigurationContainer(new Reader(), c);
    expect(reader.Value).to.equal('child');
    expect(Object.keys(reader)).to.not.include('__configurationContainer__');
  });
});
