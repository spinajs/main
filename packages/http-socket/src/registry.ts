import { Autoinject, Class, Container, DI, IContainer, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { MAX_NAME_LENGTH, NAME_PATTERN } from '@spinajs/http-socket-common';
import { IControllerDescriptor, IRoute, resolveRoutePolicies } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { BaseSocketController } from './controller.js';
import { IRegisteredHandler, ISocketControllerDescriptor, ISocketHandlerDescriptor } from './interfaces.js';

@Injectable()
export class SocketHandlerRegistry {
  @Logger('http-socket')
  protected Log: Log;

  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(Configuration)
  protected Cfg: Configuration;

  protected commands = new Map<string, IRegisteredHandler>();
  protected events = new Map<string, IRegisteredHandler>();
  protected connectHooks: IRegisteredHandler[] = [];
  protected disconnectHooks: IRegisteredHandler[] = [];

  public get Commands(): ReadonlyMap<string, IRegisteredHandler> {
    return this.commands;
  }

  public async build(): Promise<void> {
    this.commands.clear();
    this.events.clear();
    this.connectHooks = [];
    this.disconnectHooks = [];

    const types = (DI.getRegisteredTypes(BaseSocketController) ?? []) as Array<Class<BaseSocketController>>;

    for (const type of types) {
      const controller = (await DI.resolve(type)) as BaseSocketController;
      const descriptor = controller.Descriptor;

      if (!descriptor) {
        this.Log.warn(`Socket controller ${type.name} has no socket decorators, skipped`);
        continue;
      }

      for (const [, handler] of descriptor.Handlers) {
        await this.add(type.name, controller, descriptor, handler);
      }
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

    this.Log.trace(`Registered socket ${handler.Kind} ${fullName} -> ${controllerName}::${String(handler.Method)}`);
  }

  protected unique(map: Map<string, IRegisteredHandler>, registered: IRegisteredHandler, controllerName: string): void {
    const existing = map.get(registered.fullName);

    if (existing) {
      throw new InvalidOperation(`Socket ${registered.descriptor.Kind} ${registered.fullName} is declared twice: ${existing.controller.constructor.name}::${String(existing.descriptor.Method)} and ${controllerName}::${String(registered.descriptor.Method)}`);
    }

    map.set(registered.fullName, registered);
  }
}
