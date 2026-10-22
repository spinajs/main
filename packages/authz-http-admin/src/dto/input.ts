import { AuthzAdminFailure } from '@spinajs/authz';
import { isPlainObject } from '@spinajs/util';

/**
 * A request input the route-argument extraction builds from the parsed body or query string and
 * then validates against the class's `@Schema`.
 */
export abstract class AuthzAdminInput {
  constructor(data: unknown) {
    // Validation runs on the built instance, which would turn a JSON array into an object of index keys.
    if (!isPlainObject(data)) throw new AuthzAdminFailure('invalid_request', 'the body must be a JSON object');
    Object.assign(this, data);
  }
}
