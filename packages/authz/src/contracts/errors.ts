import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import type { Decision } from './decision.js';
import { resourceKey } from './resource.js';

export class AuthzConfigError extends Error {
  // boot/programming errors
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UnknownPermission extends AuthzConfigError {}

export class AccessDenied extends Forbidden {
  public readonly decision: Decision;

  constructor(decision: Decision, message?: string) {
    super(message ?? `Access denied: ${decision.permission} on ${resourceKey(decision.resource)}${decision.reason ? ` (${decision.reason.code})` : ''}`);
    this.name = new.target.name;
    this.decision = decision;
  }
}

// @spinajs/exceptions has no Unauthorized; @spinajs/http maps AuthenticationFailed to 401.
export class Unauthenticated extends AuthenticationFailed {
  constructor(message?: string, inner?: Error | unknown) {
    super(message, inner);
    this.name = new.target.name;
  }
}

export class NeedsAsync extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
