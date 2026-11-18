import 'mocha';
import { expect } from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { chooseEnvironment } from '../src/index.js';
import { configurationOf, NoSource } from './fixtures.js';

const node = ['node', 'main.js'];

describe('chooseEnvironment', () => {
  it('takes --env first, then APP_ENV, then NODE_ENV, then development', () => {
    const all = { APP_ENV: 'test', NODE_ENV: 'production' };
    expect(chooseEnvironment([...node, '--env', 'staging'], all)).to.deep.equal({ name: 'staging', from: '--env' });
    expect(chooseEnvironment(node, all)).to.deep.equal({ name: 'test', from: 'APP_ENV' });
    expect(chooseEnvironment(node, { NODE_ENV: 'production' })).to.deep.equal({ name: 'production', from: 'NODE_ENV' });
    expect(chooseEnvironment(node, {})).to.deep.equal({ name: 'development', from: 'default' });
  });

  it('skips an --env without a value', () => {
    expect(chooseEnvironment([...node, '--env'], { APP_ENV: 'test' })).to.deep.equal({ name: 'test', from: 'APP_ENV' });
  });

  it('keeps an empty APP_ENV, which selects the prod files', () => {
    expect(chooseEnvironment(node, { APP_ENV: '', NODE_ENV: 'development' })).to.deep.equal({ name: '', from: 'APP_ENV' });
  });

  it('reads process.argv and process.env by default', () => {
    const saved = process.env.APP_ENV;
    process.env.APP_ENV = 'from-process';
    try {
      expect(chooseEnvironment()).to.deep.equal({ name: 'from-process', from: 'APP_ENV' });
    } finally {
      if (saved === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = saved;
    }
  });
});

describe('chooseEnvironment agrees with the loaded configuration', () => {
  const saved = { argv: process.argv, APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
  const containers: IContainer[] = [];

  const setProcess = (args: string[], APP_ENV?: string, NODE_ENV?: string) => {
    process.argv = [...node, ...args];
    if (APP_ENV === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = APP_ENV;
    if (NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = NODE_ENV;
  };

  const loadedEnv = async () => {
    const c = DI.RootContainer.child();
    containers.push(c);
    c.register(NoSource).as(ConfigurationSource);
    c.register(configurationOf({})).as(Configuration);
    const config = await c.resolve(Configuration);
    return config.get<string>('process.env.APP_ENV');
  };

  afterEach(async () => {
    setProcess([], saved.APP_ENV, saved.NODE_ENV);
    process.argv = saved.argv;
    for (const c of containers.splice(0).reverse()) await c.dispose();
  });

  const cases: [string, string[], string | undefined, string | undefined][] = [
    ['--env', ['--env', 'staging'], 'test', 'production'],
    ['APP_ENV', [], 'test', 'production'],
    ['NODE_ENV', [], undefined, 'production'],
    ['nothing', [], undefined, undefined],
    ['an empty APP_ENV', [], '', 'development'],
  ];

  for (const [name, args, appEnv, nodeEnv] of cases) {
    it(`when ${name} decides`, async () => {
      setProcess(args, appEnv, nodeEnv);
      expect(await loadedEnv()).to.equal(chooseEnvironment().name);
    });
  }
});
