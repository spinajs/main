import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AUTHZ_DEFAULTS, AuthzDomains, DefaultAuthzDomains, readDomainConfig, redact } from '@spinajs/authz';
import type { Decision, RedactFieldSet } from '@spinajs/authz';
import { IRegisteredHandler, ISocketCommandContext, ISocketReplyContext, STAGE_ORDER, SocketMiddleware } from '../interfaces.js';
import { ISocketAccess, socketAccessDomain, socketAccessOf } from '../access.js';
import { isStreamResult } from '../stream.js';

/** The handler's own `@SocketAccess` rule, else its controller's: the one whose decision is in the call storage. */
function accessOf(handler: IRegisteredHandler | undefined): ISocketAccess | undefined {
  return handler ? (socketAccessOf(handler.descriptor.Policies) ?? socketAccessOf(handler.controller.Descriptor?.Policies)) : undefined;
}

/**
 * Not a generator: a generator's return() never reaches a source it has not started, and queues behind a pending next(),
 * so the dispatcher's close of a refused or failed stream would leak what the source holds.
 */
function filtered(source: AsyncIterable<unknown>, filter: (chunk: unknown) => unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      const iterator = source[Symbol.asyncIterator]();

      // a done step carries no value: a generator's `return x` must not pass unfiltered
      const settle = (step: IteratorResult<unknown>): IteratorResult<unknown> => (step.done ? { done: true, value: undefined } : { done: false, value: filter(step.value) });

      return {
        next: async (...args: [] | [undefined]) => settle(await iterator.next(...args)),
        return: async () => (iterator.return ? settle(await iterator.return()) : { done: true, value: undefined }),
        throw: async (error?: unknown) => {
          if (iterator.throw) {
            return settle(await iterator.throw(error));
          }
          await iterator.return?.();
          throw error;
        },
      };
    },
  };
}

/**
 * `@SocketAccess(…, { fields: 'filter' })`: the command result, or each chunk of a stream reply, limited to
 * `decision.fields.read` minus the domain's `fields.neverRead`, as authz-http's `fields: 'filter'` limits a response ( B17 ).
 * A call another policy group admitted has no decision, so only `neverRead` applies.
 * A binary result or chunk passes unchanged; a binary value nested in an object goes through filterObject, as in HTTP's JSON.
 */
@Injectable(SocketMiddleware)
export class AccessFieldsStage extends SocketMiddleware {
  @Config('authz')
  protected Authz: unknown;

  public get Order(): number {
    // after the policies left the decision; wraps the arguments and the handler
    return STAGE_ORDER.Policies + 50;
  }

  public isEnabled(handler: IRegisteredHandler): boolean {
    const fields = accessOf(handler)?.fields;
    return fields === 'filter' || fields === 'filter-rows';
  }

  public onBefore(ctx: ISocketCommandContext): void {
    if (accessOf(ctx.handler)?.fields === 'filter-rows') ctx.storage.AuthzRowFields = true;
  }

  public onAfter(ctx: ISocketReplyContext): void {
    if (ctx.error !== undefined) {
      return;
    }

    const fields = this.readable(ctx.storage.AuthzDecision, socketAccessDomain(ctx.handler!.descriptor.Policies, ctx.handler!.controller.Descriptor?.Policies));
    const filter = (data: unknown): unknown => redact(data, fields);
    ctx.result = isStreamResult(ctx.result) ? filtered(ctx.result, filter) : filter(ctx.result);
  }

  protected readable(decision: Decision | undefined, domain: string): RedactFieldSet {
    const domains = DI.get(AuthzDomains);
    const neverRead = domains instanceof DefaultAuthzDomains ? readDomainConfig(this.Authz, domains.lineage(decision?.domain ?? domain)).fields.neverRead : AUTHZ_DEFAULTS.fields.neverRead;
    return { read: decision?.fields.read ?? ['*'], neverRead };
  }
}
