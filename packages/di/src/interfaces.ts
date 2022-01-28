import { ResolveType } from './enums';
import { Class, Factory } from './types';
import { EventEmitter } from "events";

/**
 * Interface to describe DI binding behaviour
 */
export interface IBind {
  /**
   * Private var for holding implementation type
   */
  _impl: any;

  /**
   * `as` binding (alias)
   *
   * @param type - base class that is being registered
   */
  as<T>(type: Class<T> | string): this;

  /**
   * self bind, class should be resolved by its name. Its default behaviour.
   */
  asSelf(): this;

  /**
   * Registers object as single instance ( singleton )
   */
  singleInstance(): this;
}

export interface IContainer extends EventEmitter {
  Cache: Map<string, any[] | any>;
  Registry: Map<string, any[] | any>;

  clear(): void;
  clearRegistry(): void;
  clearCache(): void;

  register<T>(implementation: Class<T> | Factory<T>): IBind;

  child(): IContainer;
  get<T>(service: TypedArray<T>, parent?: boolean): T[];
  get<T>(service: string | Class<T>, parent?: boolean): T;
  get<T>(service: string | Class<T> | TypedArray<T>, parent?: boolean): T | T[];
  getRegistered<T>(service: string | Class<T>, parent: boolean): Class<any>[];

  has<T>(service: string | Class<T>, parent?: boolean): boolean;
  hasRegistered<T>(service: Class<T> | string, parent?: boolean): boolean;

  resolve<T>(type: string, options?: any[], check?: boolean): T;
  resolve<T>(type: string, check?: boolean): T;
  resolve<T>(
    type: Class<T> | Factory<T>,
    options?: any[] | boolean,
    check?: boolean,
  ): T extends AsyncModule ? Promise<T> : T;
  resolve<T>(
    type: TypedArray<T>,
    options?: any[] | boolean,
    check?: boolean,
  ): T extends AsyncModule ? Promise<T[]> : T[];
  resolve<T>(type: Class<T> | Factory<T>, check?: boolean): T extends AsyncModule ? Promise<T> : T;
  resolve<T>(type: TypedArray<T>, check?: boolean): T extends AsyncModule ? Promise<T[]> : T[];
}

/**
 * Injection description definition structure
 */
export interface IInjectDescriptor<T = any> {
  inject: IToInject<T>[];
  resolver: ResolveType;
}

export interface IToInject<T = any> {
  inject: Class<T>;
  autoinject: boolean;
  autoinjectKey: string;
}

export interface IResolvedInjection {
  instance: any;
  autoinject: boolean;
  autoinjectKey: string;
}

/**
 * Interface to describe DI resolve strategies. Strategies are used do
 * do some work at object creation eg. initialize objects that inherits from same class
 * specific way but without need for factory function.
 *
 *
 * @see FrameworkModuleSyncModule implementation
 */
// export interface IStrategy {
//     resolve: (target: any, container: IContainer) => void;
// }

// export interface IAsyncStrategy {
//     resolveA: (target: any, container: IContainer) => Promise<void>;
// }

export class Module {
  protected resolved: boolean = false;
  public get Resolved(): boolean {
    return this.resolved;
  }
}

export abstract class SyncModule extends Module {

  public resolve(_: IContainer) {
    this.resolved = true;
  }

}

export class AsyncModule extends Module {
  public async resolveAsync(_: IContainer): Promise<void> {
    this.resolved = true;
  }
}
