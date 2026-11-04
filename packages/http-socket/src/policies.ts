import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Forbidden } from '@spinajs/exceptions';
import { AccessDenied, FALSE } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { BasePolicy, IController, IRoute, createPolicyGate } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { SocketException } from '@spinajs/http-socket-common';
import { IRegisteredHandler, ISocketCallContext, ISocketCallStorage, ISocketHandshake } from './interfaces.js';
import { SocketConnection } from './connection.js';

/**
 * What a `BasePolicy` receives in place of the express request. Policies that read only
 * `req.storage` ( authz-v3's `Principal` / `AuthnPrincipal` keys ) and resource extractors that
 * read `req.body` / `req.params` work unchanged.
 */
export interface ISocketPolicyRequest {
  readonly method: 'SOCKET';
  /** full command / event name */
  readonly originalUrl: string;
  readonly url: string;
  readonly headers: ISocketHandshake['headers'];
  readonly cookies: ISocketHandshake['cookies'];
  readonly ip: string;
  readonly body: unknown;
  /** the payload's own fields when it is an object */
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  /** the call storage; what a policy writes here the handler sees in its AsyncLocalStorage store */
  readonly storage: ISocketCallStorage;
  readonly socketConnection: SocketConnection;
}

export function policyRequest(ctx: ISocketCallContext): ISocketPolicyRequest {
  const name = ctx.handler?.fullName ?? '';
  const payload = ctx.payload;
  const fields = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const handshake = ctx.connection.handshake;

  return {
    method: 'SOCKET',
    originalUrl: name,
    url: name,
    headers: handshake.headers,
    cookies: handshake.cookies,
    ip: handshake.address,
    body: payload,
    params: fields,
    query: {},
    storage: ctx.storage,
    socketConnection: ctx.connection,
  };
}

type PolicyGateFn = (req: unknown, res: unknown, next: (...args: unknown[]) => void) => void;

function noPolicy(ctx: ISocketCallContext, handler: IRegisteredHandler): Decision {
  const principal = ctx.storage.Principal;
  return Object.freeze({
    allowed: false,
    permission: '',
    resource: { type: 'socket', id: handler.fullName },
    principal: { type: principal.type, id: principal.id },
    residual: FALSE,
    fields: { read: [], write: [] },
    roles: {},
    reason: { code: 'no_policy' },
    domain: 'root',
  });
}

/** Runs http's own policy gate, so socket and http policies combine exactly alike. */
@Injectable()
export class SocketPolicyGate {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket.access.default', { defaultValue: 'deny' })
  protected Default: 'allow' | 'deny';

  protected gates = new WeakMap<IRegisteredHandler, PolicyGateFn>();
  protected routes = new WeakMap<IRegisteredHandler, IRoute>();

  /** A handler no enabled policy group guards, which the gate would let through; refused under `http.socket.access.default: 'deny'`. */
  public assertGuarded(ctx: ISocketCallContext): void {
    const handler = ctx.handler;
    if (!handler || this.Default === 'allow' || this.guarded(handler)) {
      return;
    }

    throw new AccessDenied(noPolicy(ctx, handler), `socket ${handler.descriptor.Kind} ${handler.fullName} has no @SocketAccess or @SocketPolicy (http.socket.access.default is 'deny')`);
  }

  public guarded(handler: IRegisteredHandler): boolean {
    const route = this.routeOf(handler);
    const controller = handler.controller as unknown as IController;
    const enabled = (groups: BasePolicy[][]) => groups.some((group) => group.some((p) => p.isEnabled(route, controller)));
    return enabled(handler.policies.Controller) || enabled(handler.policies.Route);
  }

  public async check(ctx: ISocketCallContext): Promise<void> {
    const handler = ctx.handler;
    if (!handler) {
      throw new SocketException('internal', 'policy check before handler lookup');
    }

    const gate = this.gateOf(handler);
    const request = policyRequest(ctx);

    await new Promise<void>((resolve, reject) => {
      // http's gate calls next() to pass and next(err) to refuse; a policy that rejects with
      // undefined must still refuse, so the argument count decides, not the value.
      gate(request, {}, (...args: unknown[]) => (args.length === 0 ? resolve() : reject(args[0] ?? new Forbidden('access denied by policy'))));
    });
  }

  protected gateOf(handler: IRegisteredHandler): PolicyGateFn {
    let gate = this.gates.get(handler);

    if (!gate) {
      gate = createPolicyGate(handler.policies, this.routeOf(handler), handler.controller as unknown as IController, this.Log) as unknown as PolicyGateFn;
      this.gates.set(handler, gate);
    }

    return gate;
  }

  protected routeOf(handler: IRegisteredHandler): IRoute {
    let route = this.routes.get(handler);

    if (!route) {
      route = {
        Method: handler.descriptor.Method,
        Path: handler.fullName,
        Type: 'socket',
        InternalType: 'socket',
        Policies: handler.descriptor.Policies,
        Middlewares: [],
        Parameters: new Map(),
        Options: handler.descriptor.Options,
        Schema: handler.descriptor.Options.schema ?? null,
      } as unknown as IRoute;
      this.routes.set(handler, route);
    }

    return route;
  }
}
