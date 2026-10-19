import * as chai from 'chai';
import 'mocha';
import { AppEnvSource, explicitAppEnv, isDevOrTestEnv, isProduction } from '../src/app-env.js';

const expect = chai.expect;

const source = (values: Record<string, unknown>, NamedEnv?: string): AppEnvSource => ({
  get: <T>(path: string | string[]) => values[String(path)] as T,
  NamedEnv,
});

describe('explicitAppEnv', () => {
  it('is undefined for a development no source named', () => {
    expect(explicitAppEnv(source({ 'process.env.APP_ENV': 'development' }))).to.equal(undefined);
    expect(explicitAppEnv(source({ 'process.env.APP_ENV': 'development' }, 'staging'))).to.equal(undefined);
  });

  it('keeps a development a source named', () => {
    expect(explicitAppEnv(source({ 'process.env.APP_ENV': 'development' }, 'development'))).to.equal('development');
  });

  it('keeps any other resolved env, named or set by a config file', () => {
    expect(explicitAppEnv(source({ 'process.env.APP_ENV': 'staging' }, 'staging'))).to.equal('staging');
    expect(explicitAppEnv(source({ 'process.env.APP_ENV': 'staging' }))).to.equal('staging');
    expect(explicitAppEnv(source({ 'process.env.APP_ENV': '' }, ''))).to.equal('');
  });

  it('is undefined without a configuration or a string env', () => {
    expect(explicitAppEnv(undefined)).to.equal(undefined);
    expect(explicitAppEnv(source({}))).to.equal(undefined);
    expect(explicitAppEnv(source({ 'process.env.APP_ENV': 3 }))).to.equal(undefined);
  });
});

describe('isDevOrTestEnv', () => {
  it('accepts development and test only', () => {
    for (const env of ['dev', 'development', 'test']) expect(isDevOrTestEnv(env), env).to.equal(true);
    for (const env of ['prod', 'production', 'staging', 'local', 'Test', '', null, undefined]) expect(isDevOrTestEnv(env), String(env)).to.equal(false);
  });
});

describe('isProduction', () => {
  const saved = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
  const setEnv = (APP_ENV?: string, NODE_ENV?: string) => {
    for (const [k, v] of Object.entries({ APP_ENV, NODE_ENV })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  afterEach(() => setEnv(saved.APP_ENV, saved.NODE_ENV));

  it('takes a boolean flag as is', () => {
    setEnv('production');
    expect(isProduction(false)).to.equal(false);
    setEnv('development');
    expect(isProduction(true)).to.equal(true);
  });

  it('normalizes an env name', () => {
    expect(isProduction('prod')).to.equal(true);
    expect(isProduction('production')).to.equal(true);
    expect(isProduction('')).to.equal(true);
    expect(isProduction('development')).to.equal(false);
    expect(isProduction('staging')).to.equal(false);
  });

  it('reads the flag of a configuration, else its resolved APP_ENV', () => {
    setEnv('production');
    expect(isProduction(source({ 'configuration.isProduction': false, 'process.env.APP_ENV': 'prod' }))).to.equal(false);
    expect(isProduction(source({ 'process.env.APP_ENV': 'development' }))).to.equal(false);
    setEnv('development');
    expect(isProduction(source({ 'process.env.APP_ENV': 'prod' }))).to.equal(true);
  });

  it('falls back to APP_ENV, then NODE_ENV, then development of the process', () => {
    setEnv('prod', 'development');
    expect(isProduction(undefined)).to.equal(true);
    setEnv('development', 'production');
    expect(isProduction(undefined)).to.equal(false);
    setEnv(undefined, 'production');
    expect(isProduction(undefined)).to.equal(true);
    expect(isProduction(source({}))).to.equal(true);
    setEnv(undefined, undefined);
    expect(isProduction(undefined)).to.equal(false);
  });
});
