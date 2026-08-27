// tslint:disable-next-line: no-var-requires

import { PasswordProvider, PasswordValidationProvider } from './interfaces.js';
import * as argon from 'argon2';
import { Autoinject, Injectable } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { DataValidator } from '@spinajs/validation';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { randomInt } from 'crypto';

/**
 * How many draws `generate()` makes before declaring the generator pool and the
 * validation rule incompatible.
 *
 * The pool says which characters may appear, not which classes are MANDATORY, so
 * a uniform draw can legitimately miss a class the rule demands - with a
 * 62-character alphanumeric pool at length 16, about 6% of draws contain no
 * digit. One draw plus an assertion would therefore fail 6% of the time, which
 * is a broken generator rather than a misconfiguration signal. Ten draws bring a
 * spurious failure to roughly 6e-13, while a pool that genuinely cannot satisfy
 * the rule still exhausts every attempt and throws.
 */
const GENERATE_ATTEMPTS = 10;

/**
 * Simple password service that use argon2 hash alghoritm
 */
@Injectable(PasswordProvider)
export class BasicPasswordProvider implements PasswordProvider {
  @Config('rbac.password.generator')
  protected GeneratorOptions: { length: number; characters: string[] };

  @AutoinjectService('rbac.password.validation')
  protected Validation: PasswordValidationProvider;

  public async hash(input: string): Promise<string> {
    // uses default argon settings, no need to tweak
    return await argon.hash(input);
  }

  /**
   *
   * Checks if hash is valid for given password
   *
   * @param hash - hash to validate
   * @param password - password to validate
   */
  public async verify(hash: string, password: string): Promise<boolean> {
    return await argon.verify(hash, password);
  }

  /**
   * A random password drawn from `rbac.password.generator` and guaranteed to
   * satisfy `rbac.password.validation.rule`.
   *
   * The guarantee matters: a generated password is what a freshly created
   * account holds, and one that fails the application's own rule is a password
   * the account can never legitimately return to.
   *
   * @throws UnexpectedServerError when the configured pool cannot produce a
   *   password the rule accepts. That is a configuration fault nobody calling
   *   this can fix, so it must never reach a client as a 400.
   */
  public generate(): string {
    const length = this.GeneratorOptions?.length ?? 16;
    const pool = (this.GeneratorOptions?.characters ?? []).join('');

    if (length < 1 || pool.length === 0) {
      throw new UnexpectedServerError('rbac.password.generator must define a positive length and a non-empty character pool');
    }

    for (let attempt = 0; attempt < GENERATE_ATTEMPTS; attempt++) {
      // randomInt is the CSPRNG - Math.random is predictable from a handful of
      // outputs, and this value guards an account.
      const candidate = Array.from({ length }, () => pool[randomInt(pool.length)]).join('');

      if (this.Validation.check(candidate)) {
        return candidate;
      }
    }

    throw new UnexpectedServerError(`Could not generate a password satisfying rbac.password.validation.rule in ${GENERATE_ATTEMPTS} attempts. The generator character pool and the validation rule disagree - check rbac.password.generator.`);
  }
}

/**
 * Simple password validation service based on JSON schema validation
 */
@Injectable(PasswordValidationProvider)
export class BasicPasswordValidationProvider extends PasswordValidationProvider {
  @Config('rbac.password.validation.rule')
  protected ValidationSchema: object;

  @Autoinject()
  protected Validator: DataValidator;

  public check(password: string): boolean {
    const [result] = this.Validator.tryValidate(this.ValidationSchema, password as any);
    return result;
  }
}
