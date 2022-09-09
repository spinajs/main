import { AsyncModule } from '@spinajs/di';
import { CommandOptions } from 'commander';

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
}

export interface IArgument {
  name: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
}

/**
 * Wrapper class for commander  https://github.com/tj/commander.js
 * To declare opions & arguments use decorators. This class is resolved
 * when cli module is created.
 *
 * It allows to use all features that spinajs provides eg. DI, logging, intl support etc.
 * inside command functions without hassle.
 */
export abstract class CliCommand extends AsyncModule {
  /**
   * Function executed when command is running
   *
   * @param args - args passed from cli
   */
  public abstract execute(...args: any[]): Promise<void>;
}
