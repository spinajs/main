import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { join, normalize, resolve } from 'path';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';

import { BasicPasswordProvider, BasicPasswordValidationProvider } from '../src/password.js';
import { PasswordProvider, PasswordValidationProvider } from '../src/interfaces.js';
import { TestConfiguration } from './common.test.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('Password provider tests', () => {
  /**
   * BasicPasswordProvider now carries @Config('rbac.password.generator') and
   * @AutoinjectService('rbac.password.validation') fields, so - unlike at
   * baseline - resolving PasswordProvider requires a Configuration and a
   * PasswordValidationProvider to be registered too. Re-registered and
   * re-resolved per test (rather than once in `before`) because afterEach
   * clears the DI cache, and DI.get(Configuration) used by @Config is a
   * synchronous cache read.
   */
  beforeEach(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(BasicPasswordValidationProvider).as(PasswordValidationProvider);

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  it('Should hash password', async () => {
    const provider = await DI.resolve(PasswordProvider);
    const hashed = await provider.hash('bbbb');
    expect(typeof hashed).to.be.eq('string');
    expect(hashed.length).to.gt(12);
  });

  it('Should verify password', async () => {
    const provider = await DI.resolve(PasswordProvider);
    const ok = await provider.verify('$argon2i$v=19$m=4096,t=3,p=1$xS9IIsZik2It+PrdjFNKiA$3sEyHfIHLXObxIm8Jva5F18MNB9O+yOw4Lkh+P7+Sdk', 'bbbb');
    const notok = await provider.verify('$argon2i$v=19$m=4096,t=3,p=1$xSddasddsaqPrdjFNKiA$3sEyHfIHLXObxIm8Jva5F18MNB9O+yOw4Lkh+P7+Sdk', 'bbbb');

    expect(notok).to.be.false;
    expect(ok).to.be.true;
  });

  it('Should generate password', async () => {
    const provider = await DI.resolve(PasswordProvider);
    const password = provider.generate();
    expect(typeof password).to.be.eq('string');
    expect(password.length).to.gt(1);
  });
});

describe('BasicPasswordProvider.generate', function () {
  this.timeout(15000);

  let provider: PasswordProvider;
  let config: Configuration;

  beforeEach(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(BasicPasswordValidationProvider).as(PasswordValidationProvider);

    config = await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    provider = await DI.resolve(PasswordProvider);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('generates a password of the configured length from the configured characters', () => {
    config.set('rbac.password.generator', { length: 24, characters: ['abc', '123'] });

    const password = provider.generate();

    expect(password).to.have.lengthOf(24);
    expect(password.split('').every((c) => 'abc123'.includes(c)), `unexpected character in ${password}`).to.eq(true);
  });

  /**
   * The shipped default rule demands a digit. A uniform draw from an
   * alphanumeric pool misses one often enough (~6% at length 16) that the
   * generator must retry rather than hand back an invalid password.
   */
  it('always returns a password satisfying the validation rule', () => {
    config.set('rbac.password.generator', { length: 16, characters: ['abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'] });
    config.set('rbac.password.validation.rule', { type: 'string', pattern: '^(?=.*\\d).{8,}$' });

    for (let i = 0; i < 200; i++) {
      expect(/^(?=.*\d).{8,}$/.test(provider.generate()), 'generated password must satisfy the configured rule').to.eq(true);
    }
  });

  /**
   * A pool that cannot satisfy the rule is a misconfiguration the caller cannot
   * fix, so it must surface as a server error - never as a 400 on whoever
   * happened to create an account.
   */
  it('throws a server error when the pool cannot satisfy the rule', () => {
    config.set('rbac.password.generator', { length: 16, characters: ['abcdef'] });
    config.set('rbac.password.validation.rule', { type: 'string', pattern: '^(?=.*\\d).{8,}$' });

    expect(() => provider.generate()).to.throw(UnexpectedServerError);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => provider.generate()));
    expect(seen.size, 'generated passwords must not collide').to.eq(50);
  });

  /**
   * Regression coverage for the rbac-http-admin break under commit 53c8845:
   * that test harness declares its own `rbac` config block without merging
   * rbac's shipped defaults underneath it, so `rbac.password.generator` is
   * absent there entirely (not just missing a field) - see the comment on
   * `rbac.actions` in packages/rbac-http-admin/test/common.ts, and the
   * `_cfg(path, [])` fallback in `_create_middleware`
   * (packages/rbac/src/actions.ts) for the same class of problem.
   *
   * An application that never declares the key must still be able to create
   * users, so generate() falls back to DEFAULT_GENERATOR (src/password.ts).
   * A pool that *is* declared but left empty is a different case - a real
   * misconfiguration - and must keep throwing.
   */
  it('falls back to the shipped default when rbac.password.generator is not declared, but still throws when it is declared with an empty pool', () => {
    // TestConfiguration (./common.test.js) does not declare rbac.password.generator.
    const password = provider.generate();

    expect(password).to.have.lengthOf(16);
    expect(/^(?=.*\d).{8,}$/.test(password), `generated password ${password} must satisfy the default validation rule`).to.eq(true);

    config.set('rbac.password.generator', { length: 16, characters: [] });

    expect(() => provider.generate()).to.throw(UnexpectedServerError);
  });
});
