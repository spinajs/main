import { DI } from '@spinajs/di';
import { CommandOptions } from 'commander';
import { IArgument, ICommand, IOption } from './interfaces.js';

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
 * Two forms are supported: a positional form for simple cases, and an object
 * form (`@Command({ nameAndArgs, description, aliases, parent, ... })`) for
 * the full set of options.
 *
 * @param nameAndArgs - name of command with optional args defined
 * @param description  - short description
 * @param opts - additional options, see https://github.com/tj/commander.js
 */
export function Command(nameAndArgs: string, description: string, opts?: CommandOptions): (target: object) => void;
export function Command(config: ICommand): (target: object) => void;
export function Command(nameAndArgsOrConfig: string | ICommand, description?: string, opts?: CommandOptions) {
  return function (target: object) {
    const meta: ICommand =
      typeof nameAndArgsOrConfig === 'string'
        ? { nameAndArgs: nameAndArgsOrConfig, description: description ?? '', opts }
        : nameAndArgsOrConfig;

    Reflect.defineMetadata(META_COMMAND, meta, target);

    DI.register(target).as('__cli_command__');
  };
}

/**
 * Options provided for command. Option contain name and argument
 * eg. test-command -p 80
 *
 * Two forms are supported: a positional form for simple cases, and an object
 * form (`@Option({ flags, required, choices, ... })`) for the full set of options.
 *
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
): (target: object) => void;
export function Option(config: IOption): (target: object) => void;
export function Option(
  flagsOrConfig: string | IOption,
  required?: boolean,
  description?: string,
  defaultValue?: any,
  parser?: (opt: string) => unknown,
) {
  return function (target: object) {
    const arg: IOption =
      typeof flagsOrConfig === 'string'
        ? {
            flags: flagsOrConfig,
            description,
            defaultValue,
            required,
            parser: parser as IOption['parser'],
          }
        : flagsOrConfig;

    let args: IOption[] = [];

    if (Reflect.hasMetadata(META_OPTION, target)) {
      args = Reflect.getMetadata(META_OPTION, target) as IOption[];
    }
    // stacked decorators apply bottom-up, so unshift to preserve the
    // top-to-bottom declaration order.
    args.unshift(arg);

    Reflect.defineMetadata(META_OPTION, args, target);
  };
}

/**
 * Command argument
 * eg. \@Argument('first', true, 'integer argument')
 *
 * Two forms are supported: a positional form for simple cases, and an object
 * form (`@Argument({ name, required, choices, variadic, ... })`) for the full set of options.
 *
 * @param name - short description argument name
 * @param required - whether the argument is required
 * @param description - short arg description
 * @param defaultValue - default value
 * @param parser - callback function for parsing value
 * @returns
 */
export function Argument(
  name: string,
  required: boolean,
  description?: string,
  defaultValue?: any,
  parser?: (opt: string) => unknown,
): (target: object) => void;
export function Argument(config: IArgument): (target: object) => void;
export function Argument(
  nameOrConfig: string | IArgument,
  required?: boolean,
  description?: string,
  defaultValue?: any,
  parser?: (opt: string) => unknown,
) {
  return function (target: object) {
    const arg: IArgument =
      typeof nameOrConfig === 'string'
        ? {
            name: nameOrConfig,
            description,
            defaultValue,
            required,
            parser: parser as IArgument['parser'],
          }
        : nameOrConfig;

    let args: IArgument[] = [];

    if (Reflect.hasMetadata(META_ARGUMENT, target)) {
      args = Reflect.getMetadata(META_ARGUMENT, target) as IArgument[];
    }
    // stacked decorators apply bottom-up, so unshift to preserve the
    // top-to-bottom declaration order.
    args.unshift(arg);

    Reflect.defineMetadata(META_ARGUMENT, args, target);
  };
}
