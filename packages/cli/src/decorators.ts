import { CommandOptions } from 'commander';
import { IArgument, IOption } from './interfaces';

export const META_COMMAND = 'cli:command';
export const META_ARGUMENT = 'cli:argument';
export const META_OPTION = 'cli:options';

/**
 * Cli command, wrapper for lib commander. For more docs on command options & args check
 * https://github.com/tj/commander.js
 *
 * It allows to use all features that spinajs provides eg. DI, logging, intl support etc.
 * inside command functions without hassle.
 *
 * @param nameAndArgs - name of command with optional args defined
 * @param description  - short description
 * @param opts - additional options, see https://github.com/tj/commander.js
 */
export function Command(nameAndArgs: string, description: string, opts?: CommandOptions) {
  return function (target: object) {
    const arg = {
      nameAndArgs,
      description,
      opts,
    };

    Reflect.defineMetadata(META_COMMAND, arg, target);
  };
}

/**
 * Options provided for command. Option contain name and argument
 * eg. test-command -p 80
 * @param flags - short flag (single character) and a long name, separated by a comma or space or vertical bar ('|').
 * @param required - if options is required for command
 * @param description - short description for option
 * @param defaultValue - default value if none provided
 * @param parser - callback function for parsing value
 *
 */
export function Option(
  flags: string,
  required?: boolean,
  description?: string,
  defaultValue?: any,
  parser?: (opt: string) => unknown,
) {
  return function (target: object) {
    const arg = {
      flags,
      description,
      defaultValue,
      required,
      parser,
    };
    let args: IOption[] = [];

    if (Reflect.hasMetadata(META_OPTION, target)) {
      args = Reflect.getMetadata(META_OPTION, target) as IOption[];
    }
    args.push(arg);

    Reflect.defineMetadata(META_OPTION, args, target);
  };
}

/**
 * Command argument
 * eg. \@Argument('<first>', 'integer argument')
 *
 * @param name - short description argument name
 * @param description - short arg description
 * @param defaultValue - default value
 * @param parser - callback function for parsing value
 * @returns
 */
export function Argument(name: string, description?: string, defaultValue?: any, parser?: (opt: string) => unknown) {
  return function (target: object) {
    const arg = {
      name,
      description,
      defaultValue,
      parser,
    };
    let args: IArgument[] = [];

    if (Reflect.hasMetadata(META_ARGUMENT, target)) {
      args = Reflect.getMetadata(META_ARGUMENT, target) as IArgument[];
    }
    args.push(arg);

    Reflect.defineMetadata(META_ARGUMENT, args, target);
  };
}
