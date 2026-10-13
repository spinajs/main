import { ErrorObject } from 'ajv';

export interface ConfigurationViolation {
  /** Full configuration path of the bad value, eg. `authn.audit.sinkTimeoutMs`. */
  path: string;
  /** The schema checked against: its `$id`, else its `$configurationModule`. */
  schema: string;
  message: string;
}

export class InvalidConfiguration extends Error {
  constructor(message: string, public validationExceptions?: ErrorObject[], public violations: ConfigurationViolation[] = []) {
    super(message);
  }
}
