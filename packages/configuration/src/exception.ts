import { ErrorObject } from 'ajv';

export class InvalidConfiguration extends Error {
  constructor(message: string, public validationExceptions: ErrorObject[]) {
    super(message);
  }
}
