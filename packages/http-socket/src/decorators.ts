import { Class, DI, getInheritedDescriptor } from '@spinajs/di';
import { BasePolicy, IPolicyGroup } from '@spinajs/http';
import { BaseSocketController } from './controller.js';
import { ConnectionArg, FromDiArg, PayloadArg, ReasonArg, SignalArg } from './args.js';
import { ICommandOptions, IEventOptions, ISocketControllerDescriptor, ISocketHandlerDescriptor, ISocketParameter, SOCKET_CONTROLLER_DESCRIPTOR, SocketArg, SocketHandlerKind } from './interfaces.js';

type SocketDecorator = (target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => void;

function createDefaultDescriptor(): ISocketControllerDescriptor {
  return { Prefix: null, Policies: [], Handlers: new Map<string | symbol, ISocketHandlerDescriptor>() };
}

// The inheritance collapse rebuilds arrays and Maps but shares their elements; copy them so a
// subclass that redeclares a handler cannot rewrite its parent's ( as http's detachInheritedRoutes ).
function detachInheritedHandlers(descriptor: ISocketControllerDescriptor): void {
  descriptor.Policies = descriptor.Policies.map((group) => [...group]);

  for (const [member, handler] of descriptor.Handlers) {
    descriptor.Handlers.set(member, {
      ...handler,
      Options: { ...handler.Options },
      Policies: handler.Policies.map((group) => [...group]),
      Parameters: new Map([...handler.Parameters].map(([index, parameter]): [number, ISocketParameter] => [index, { ...parameter }])),
    });
  }
}

function SocketDescriptor(callback: (descriptor: ISocketControllerDescriptor, target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => void): SocketDecorator {
  return (target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => {
    const owner = target.prototype ?? target;
    const isFirstDecorator = !Reflect.getOwnMetadata(SOCKET_CONTROLLER_DESCRIPTOR, owner);
    const descriptor = getInheritedDescriptor<ISocketControllerDescriptor>(owner, SOCKET_CONTROLLER_DESCRIPTOR, createDefaultDescriptor);

    if (isFirstDecorator) {
      detachInheritedHandlers(descriptor);
    }

    callback(descriptor, target, propertyKey, indexOrDescriptor);
  };
}

function handlerOf(descriptor: ISocketControllerDescriptor, member: string | symbol): ISocketHandlerDescriptor {
  let handler = descriptor.Handlers.get(member);

  if (!handler) {
    handler = { Kind: 'unknown', Method: member, Name: String(member), Options: {}, Parameters: new Map(), Policies: [] };
    descriptor.Handlers.set(member, handler);
  }

  return handler;
}

function Handler(kind: Exclude<SocketHandlerKind, 'unknown'>, name: string | undefined, options: ICommandOptions): SocketDecorator {
  return SocketDescriptor((descriptor, target, propertyKey) => {
    if (propertyKey === undefined) {
      throw new Error(`socket ${kind} decorators can be used only on methods`);
    }

    const handler = handlerOf(descriptor, propertyKey);

    if (handler.Kind !== 'unknown' && handler.Kind !== kind) {
      throw new Error(`${target.constructor.name}::${String(propertyKey)} is already a socket ${handler.Kind} handler`);
    }

    handler.Kind = kind;
    handler.Name = name ?? String(propertyKey);
    handler.Options = { ...options };
  });
}

/**
 * Marks a socket controller. Command and event names get the prefix ( `docs` + `open` = `docs.open` ).
 * Keep socket controllers out of `system.dirs.controllers`; list their folders in `system.dirs.socketControllers`.
 */
export function SocketController(prefix?: string) {
  const describe = SocketDescriptor((descriptor) => {
    descriptor.Prefix = prefix ? prefix : null;
  });

  return (target: Class<BaseSocketController>) => {
    describe(target);
    DI.register(target).as(BaseSocketController);
  };
}

/** Request/response command, answered through the socket.io ack. */
export function Command(name?: string, options: ICommandOptions = {}) {
  return Handler('command', name, options);
}

/** Fire-and-forget event from the client. */
export function OnEvent(name?: string, options: IEventOptions = {}) {
  return Handler('event', name, options);
}

export function OnConnect() {
  return Handler('connect', undefined, {});
}

export function OnDisconnect() {
  return Handler('disconnect', undefined, {});
}

/** Adds one policy group ( AND inside ) at class or method scope; each member carries its own constructor options. */
export function SocketPolicyGroup(group: IPolicyGroup) {
  return SocketDescriptor((descriptor, _target, propertyKey) => {
    if (group.length === 0) {
      return;
    }

    if (propertyKey === undefined) {
      descriptor.Policies.push(group);
    } else {
      handlerOf(descriptor, propertyKey).Policies.push(group);
    }
  });
}

/**
 * Same semantics as http's `@Policy`, with the same `BasePolicy` classes: every call forms one
 * group ( AND inside ), groups are alternatives ( OR ), controller and method scopes are combined
 * with AND. Policies receive an `ISocketPolicyRequest` in place of the express request.
 */
export function SocketPolicy(policy: Class<BasePolicy> | string | (Class<BasePolicy> | string)[], ...options: unknown[]) {
  return SocketPolicyGroup((Array.isArray(policy) ? policy : [policy]).map((p) => ({ Type: p, Options: options })) as IPolicyGroup);
}

/** Declares a handler argument filled by the `SocketArg` extractor `type`; the base of all argument decorators. */
export function SocketParameter(type: Class<SocketArg>, schema: object | null = null, options?: unknown) {
  return SocketDescriptor((descriptor, target, propertyKey, index) => {
    if (propertyKey === undefined || typeof index !== 'number') {
      throw new Error('socket parameter decorators can be used only on method parameters');
    }

    const types = Reflect.getMetadata('design:paramtypes', target.prototype ?? target, propertyKey) as unknown[] | undefined;
    handlerOf(descriptor, propertyKey).Parameters.set(index, { Index: index, Type: type, RuntimeType: types?.[index], Schema: schema, Options: options });
  });
}

export function Payload(schema?: object) {
  return SocketParameter(PayloadArg, schema ?? null);
}

export function Connection() {
  return SocketParameter(ConnectionArg);
}

export function Signal() {
  return SocketParameter(SignalArg);
}

export function Reason() {
  return SocketParameter(ReasonArg);
}

export function FromDI(...options: unknown[]) {
  return SocketParameter(FromDiArg, null, options.length > 0 ? options : undefined);
}
