import { Autoinject, Class, Container, DI, IContainer, Injectable } from '@spinajs/di';
import { checkPendingProperties, Configuration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { MAX_NAME_LENGTH, NAME_PATTERN } from '@spinajs/http-socket-common';
import { classLineage, IControllerDescriptor, IRoute, resolveRoutePolicies } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import type { SocketContractEntry } from '@spinajs/manifest';
import { BaseSocketController } from './controller.js';
import { SocketContractEnforcer } from './contract.js';
import { IRegisteredHandler, ISocketControllerDescriptor, ISocketHandlerDescriptor, ISocketStageRegistration, SOCKET_CONTROLLER_DESCRIPTOR, SocketMiddleware } from './interfaces.js';

const isAsyncGenerator = (controller: BaseSocketController, method: string | symbol): boolean => Object.prototype.toString.call(controller[method as keyof BaseSocketController]) === '[object AsyncGeneratorFunction]';

const hasHooks = (m: SocketMiddleware): boolean => !!(m.onBefore || m.onAfter || m.onFinish || m.onAround);

/** A 3.x stage moved onto SocketMiddleware with its execute() left in place would be skipped without a word. */
function refuseExecute(middleware: SocketMiddleware): void {
  if (typeof (middleware as { execute?: unknown }).execute === 'function') {
    throw new InvalidOperation(
      `Socket middleware ${middleware.constructor.name} defines execute(ctx, next), removed in @spinajs/http-socket 4.0: implement onAround(ctx, proceed) with the same body, or onBefore(ctx) / onAfter(ctx) / onFinish(ctx)`,
    );
  }
}

const ownSourceFile = (type: object): string | undefined => (Reflect.getOwnMetadata(SOCKET_CONTROLLER_DESCRIPTOR, (type as { prototype: object }).prototype) as ISocketControllerDescriptor | undefined)?.SourceFile;

@Injectable()
export class SocketHandlerRegistry {
  @Logger('http-socket')
  protected Log: Log;

  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(Configuration)
  protected Cfg: Configuration;

  @Autoinject(SocketContractEnforcer)
  protected Contracts: SocketContractEnforcer;

  protected commands = new Map<string, IRegisteredHandler>();
  protected events = new Map<string, IRegisteredHandler>();
  protected connectHooks: IRegisteredHandler[] = [];
  protected disconnectHooks: IRegisteredHandler[] = [];

  protected globals: SocketMiddleware[] = [];

  public get Commands(): ReadonlyMap<string, IRegisteredHandler> {
    return this.commands;
  }

  /** The global middlewares ( `@Injectable(SocketMiddleware)` ) in Order; the chain of a name no command has. */
  public get Middlewares(): readonly SocketMiddleware[] {
    return this.globals;
  }

  public async build(): Promise<void> {
    this.commands.clear();
    this.events.clear();
    this.connectHooks = [];
    this.disconnectHooks = [];

    const globals = (await DI.resolve(Array.ofType(SocketMiddleware))) as SocketMiddleware[];
    globals.forEach(refuseExecute);
    this.globals = [...globals].sort((a, b) => a.Order - b.Order);

    checkPendingProperties(this.Container);
    const types = [...new Set(DI.getRegisteredTypes(BaseSocketController) ?? [])] as Array<Class<BaseSocketController>>;
    const bound: SocketContractEntry[] = [];
    const staged: Array<[IRegisteredHandler, string]> = [];
    const descriptors = new Map<IRegisteredHandler, ISocketControllerDescriptor>();

    for (const type of types) {
      const controller = (await DI.resolve(type)) as BaseSocketController;

      if (!controller.Descriptor) {
        this.Log.warn({ controller: type.name }, 'Socket controller ${controller} has no socket decorators, skipped');
        continue;
      }

      const lineage = classLineage(type, ownSourceFile);
      const descriptor = await this.Contracts.runtimeTypes(type.name, controller.Descriptor, lineage);

      const before = { commands: new Set(this.commands.values()), events: new Set(this.events.values()) };

      for (const [, handler] of descriptor.Handlers) {
        await this.add(type.name, controller, descriptor, handler);
      }

      const added = [...this.commands.values()].filter((h) => !before.commands.has(h));
      const contract = this.Contracts.bind(
        type.name,
        descriptor,
        added,
        [...this.events.values()].filter((h) => !before.events.has(h)),
        lineage,
      );
      if (contract) bound.push(contract);
      staged.push(...added.map((h) => [h, type.name] as [IRegisteredHandler, string]));
      added.forEach((h) => descriptors.set(h, descriptor));
    }

    this.Contracts.reportUnvalidated(bound);

    // last, so a middleware sees only unique commands that carry their contract and payload validators
    for (const [handler, controllerName] of staged) {
      await this.registerWithMiddlewares(handler, controllerName, descriptors.get(handler)!);
    }
  }

  public command(name: string): IRegisteredHandler | undefined {
    return this.commands.get(name);
  }

  public event(name: string): IRegisteredHandler | undefined {
    return this.events.get(name);
  }

  public hooks(kind: 'connect' | 'disconnect'): readonly IRegisteredHandler[] {
    return kind === 'connect' ? this.connectHooks : this.disconnectHooks;
  }

  protected async add(controllerName: string, controller: BaseSocketController, descriptor: ISocketControllerDescriptor, handler: ISocketHandlerDescriptor): Promise<void> {
    if (handler.Kind === 'unknown') {
      throw new InvalidOperation(`${controllerName}::${String(handler.Method)} has socket parameter or policy decorators but no @Command, @OnEvent, @OnConnect or @OnDisconnect`);
    }

    const fullName = descriptor.Prefix ? `${descriptor.Prefix}.${handler.Name}` : handler.Name;

    if ((handler.Kind === 'command' || handler.Kind === 'event') && !(fullName.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(fullName))) {
      throw new InvalidOperation(`Socket ${handler.Kind} ${fullName} ( ${controllerName}::${String(handler.Method)} ) is not a valid socket ${handler.Kind} name: at most ${MAX_NAME_LENGTH} characters of ${NAME_PATTERN.source}`);
    }

    // http's resolver reads only Policies and Method, so the socket descriptors pass structurally
    const policies = await resolveRoutePolicies({ Policies: descriptor.Policies } as unknown as IControllerDescriptor, { Policies: handler.Policies, Method: handler.Method } as unknown as IRoute, this.Container, this.Cfg, this.Log, controllerName, fullName);

    const registered: IRegisteredHandler = { fullName, controller, descriptor: handler, policies };

    switch (handler.Kind) {
      case 'command':
        this.unique(this.commands, registered, controllerName);
        break;
      case 'event':
        this.unique(this.events, registered, controllerName);
        break;
      case 'connect':
        this.connectHooks.push(registered);
        break;
      case 'disconnect':
        this.disconnectHooks.push(registered);
        break;
    }

    this.Log.trace({ kind: handler.Kind, name: fullName, controller: controllerName, method: handler.Method }, 'Registered socket ${kind} ${name} -> ${controller}::${method}');
  }

  /** The command's chain: the global middlewares it does not declare itself, the controller's, then the command's; the enabled ones, stably sorted by Order. */
  protected async chainOf(registered: IRegisteredHandler, descriptor: ISocketControllerDescriptor): Promise<SocketMiddleware[]> {
    const declared = [...(descriptor.Middlewares ?? []), ...(registered.descriptor.Middlewares ?? [])];
    const local = await Promise.all(declared.map((m) => this.Container.resolve(m.Type, m.Options) as Promise<SocketMiddleware> | SocketMiddleware));
    local.forEach(refuseExecute);
    const globals = this.globals.filter((g) => !declared.some((m) => g.constructor === m.Type));

    return [...globals, ...local].filter((m) => m.isEnabled(registered)).sort((a, b) => a.Order - b.Order);
  }

  protected async registerWithMiddlewares(registered: IRegisteredHandler, controllerName: string, descriptor: ISocketControllerDescriptor): Promise<void> {
    const command = `Socket command ${registered.fullName} ( ${controllerName}::${String(registered.descriptor.Method)} )`;
    let refusal: string | undefined;
    const registration: ISocketStageRegistration = { refuseStream: (what) => (refusal = what) };
    const chain = await this.chainOf(registered, descriptor);

    // ascending Order, so the last refusal is the highest Order's
    for (const middleware of chain) {
      if (!middleware.onRegister) {
        continue;
      }

      try {
        await middleware.onRegister(registered, registration);
      } catch (err) {
        throw new InvalidOperation(`${command}: middleware ${middleware.constructor.name} refused the registration: ${err instanceof Error ? err.message : String(err)}`, err);
      }
    }

    (registered as { middlewares?: readonly SocketMiddleware[] }).middlewares = chain.filter(hasHooks);

    if (refusal === undefined) {
      return;
    }

    (registered as { streamRefusal?: string }).streamRefusal = refusal;
    if (isAsyncGenerator(registered.controller, registered.descriptor.Method)) {
      throw new InvalidOperation(`${command} is ${refusal} and replies with a stream; ${refusal} commands cannot stream`);
    }
  }

  protected unique(map: Map<string, IRegisteredHandler>, registered: IRegisteredHandler, controllerName: string): void {
    const existing = map.get(registered.fullName);

    if (existing) {
      throw new InvalidOperation(`Socket ${registered.descriptor.Kind} ${registered.fullName} is declared twice: ${existing.controller.constructor.name}::${String(existing.descriptor.Method)} and ${controllerName}::${String(registered.descriptor.Method)}`);
    }

    map.set(registered.fullName, registered);
  }
}
