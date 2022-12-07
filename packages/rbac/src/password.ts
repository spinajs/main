import { PasswordProvider, PasswordValidationProvider } from './interfaces';

// tslint:disable-next-line: no-var-requires
const { Entropy, charset32 } = require('entropy-string');
import * as argon from 'argon2';
import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { DataValidator } from '@spinajs/validation';

/**
 * Simple password service that use argon2 hash alghoritm and entropy-string to generate password
 */
@Injectable(PasswordProvider)
export class BasicPasswordProvider implements PasswordProvider {
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

  public generate(): string {
    // generates password with entropy of 60 bits ( balance of ease vs value )
    const random = new Entropy({ charset: charset32 });
    return random.string(60);
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
