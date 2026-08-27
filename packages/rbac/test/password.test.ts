import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { join, normalize, resolve } from 'path';

import { BasicPasswordProvider, BasicPasswordValidationProvider } from '../src/password.js';
import { PasswordProvider, PasswordValidationProvider } from '../src/interfaces.js';
import { TestConfiguration } from './common.test.js';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

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
});
