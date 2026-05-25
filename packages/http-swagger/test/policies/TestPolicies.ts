import { BasePolicy, IController, IRoute } from '@spinajs/http';

/**
 * Verifies that the caller's session is fully authorized.
 * Rejects unauthenticated requests with a 401.
 */
export class AuthorizedTestPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }
  public async execute(): Promise<void> {
    return;
  }
}

/**
 * Allows requests only outside of business hours.
 * Useful for batch endpoints that should never run during peak load.
 */
export class OffHoursTestPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }
  public async execute(): Promise<void> {
    return;
  }
}

// Intentionally undocumented — exercises the "no description available" fallback.
export class UndocumentedTestPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }
  public async execute(): Promise<void> {
    return;
  }
}
