import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AUTHZ_DEFAULTS, AuthzDomains, DefaultAuthzDomains, filterObject, readDomainConfig, subtractFieldGlobs } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { IRegisteredHandler, ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { ISocketAccess, socketAccessOf } from '../access.js';
import { isStreamResult } from '../stream.js';

/** The handler's own `@SocketAccess` rule, else its controller's: the one whose decision is in the call storage. */
function accessOf(handler: IRegisteredHandler | undefined): ISocketAccess | undefined {
  return handler ? (socketAccessOf(handler.descriptor.Policies) ?? socketAccessOf(handler.controller.Descriptor?.Policies)) : undefined;
}

async function* filtered(source: AsyncIterable<unknown>, filter: (chunk: unknown) => unknown): AsyncGenerator<unknown> {
  for await (const chunk of source) {
    yield filter(chunk);
  }
}

/**
 * `@SocketAccess(…, { fields: 'filter' })`: the command result, or each chunk of a stream reply, limited to
 * `decision.fields.read` minus the domain's `fields.neverRead`, as authz-http's `fields: 'filter'` limits a response ( B17 ).
 * A call another policy group admitted has no decision, so only `neverRead` applies. Binary values pass unchanged.
 */
@Injectable(SocketCommandStage)
export class AccessFieldsStage extends SocketCommandStage {
  @Config('authz')
  protected Authz: unknown;

  public get Order(): number {
    return STAGE_ORDER.Policies + 50;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const access = accessOf(ctx.handler);
    if (access?.fields !== 'filter') {
      return next();
    }

    const result = await next();
    const read = this.readable(ctx.storage.AuthzDecision, access.domain ?? 'root');
    const filter = (data: unknown): unknown => (data !== null && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) ? filterObject(read, data) : data);

    return isStreamResult(result) ? filtered(result, filter) : filter(result);
  }

  protected readable(decision: Decision | undefined, domain: string): readonly string[] {
    const domains = DI.get(AuthzDomains);
    const neverRead = domains instanceof DefaultAuthzDomains ? readDomainConfig(this.Authz, domains.lineage(decision?.domain ?? domain)).fields.neverRead : AUTHZ_DEFAULTS.fields.neverRead;
    const read = decision?.fields.read ?? ['*'];
    return neverRead.length === 0 ? read : subtractFieldGlobs(read, neverRead);
  }
}
