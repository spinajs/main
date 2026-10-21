import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log-common';

import { Hooks } from './contracts.js';
import type { ActionName, BeforeContext, InputOf, OutputOf, RunOptions } from './contracts.js';

/**
 * Collects the registered ActionHook types and their patterns in resolve(), without resolving them through DI: a
 * hook that injects a service that injects Hooks would make a cycle (D19). A hook's DI instance is resolved on the
 * first run of an action it matches. A hook registered after resolve() is not used.
 */
@Injectable(Hooks)
export class DefaultHooks extends Hooks {
  @Autoinject(Container)
  protected Container: IContainer;

  @Logger('hooks')
  protected Log: Log;

  @Config('hooks.timeoutMs')
  protected TimeoutMs: number;

  @Config('hooks.maxDepth')
  protected MaxDepth: number;

  public async resolve(): Promise<void> {
    throw new Error('not implemented: DefaultHooks.resolve');
  }

  public has(_action: ActionName): boolean {
    throw new Error('not implemented: DefaultHooks.has');
  }

  public async run<A extends ActionName>(_action: A, _input: InputOf<A>, _impl: (input: InputOf<A>) => Promise<OutputOf<A>>, _opts: RunOptions<A>): Promise<OutputOf<A>> {
    throw new Error('not implemented: DefaultHooks.run');
  }

  /** Called once per run that has a matching hook, never on the path without one; the after and failed contexts share its bag. */
  protected createContext<A extends ActionName>(_action: A, _input: InputOf<A>, _depth: number): BeforeContext<A> {
    throw new Error('not implemented: DefaultHooks.createContext');
  }
}
