import { Injectable } from '@spinajs/di';

export abstract class SignalAuthorizer {
  public abstract authorize(
    principal: string | undefined,
    permission: string,
    resource: Record<string, unknown> | undefined,
    ctx: { instanceId: string; workflow: string; event: string },
  ): Promise<boolean>;
}

/** Fail closed: until an authorizer such as `@spinajs/authz-workflow` is registered, no permissioned signal is consumed. */
@Injectable(SignalAuthorizer)
export class DenyAllSignalAuthorizer extends SignalAuthorizer {
  public authorize(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
