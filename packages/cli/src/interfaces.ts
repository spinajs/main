import { AsyncService } from '@spinajs/di';
import { Command, CommandOptions } from 'commander';

export interface ICommand {
  nameAndArgs: string;
  opts?: CommandOptions;
  description: string;
}

export interface IOption {
  flags: string;
  description?: string;
  defaultValue?: string | boolean | string[];
  required?: boolean;
  parser?: (opt: string) => unknown;
}

export interface IArgument {
  name: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
  parser?: (opt: string) => unknown;
}

/**
 * Wrapper class for commander  https://github.com/tj/commander.js
 * To declare opions & arguments use decorators. This class is resolved
 * when cli module is created.
 *
 * It allows to use all features that spinajs provides eg. DI, logging, intl support etc.
 * inside command functions without hassle.
 */
export abstract class CliCommand extends AsyncService {
  /**
   * Function executed when command is running
   *
   * @param args - args passed from cli
   */
  public abstract execute(...args: any[]): Promise<void>;

  /**
   * Executed on command creation, used when you need to
   * use advanced stuff from commander lib
   *
   * Decorators provide only basic command args & options declarations,
   * and are used only for simle use cases
   *
   * @param c - commander command object
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
  public onCreation(_command: Command): void {}
}
