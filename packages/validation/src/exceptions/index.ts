import { Exception } from '@spinajs/exceptions';
import { ErrorObject } from 'ajv';
/**
 * The exception that is thrown when JSON entity is checked against schema and is invalid
 */
export class ValidationFailed extends Exception {
  public parameter: IValidationError[];

  constructor(message: string, validationErrors: IValidationError[]) {
    super(message);
    this.parameter = validationErrors;
  }

  toString(): string {
    return `${this.message}\nValidation errors:\n${this.parameter.map((e) => ` - path: ${e.instancePath} keyword: ${e.keyword} ${Object.getOwnPropertyNames(e.params).map((key) => `${key}: ${e.params[key]}`).join(', ')}`).join('\n')}`;
  }
}

/* eslint-disable */
export interface IValidationError extends ErrorObject {}
