import { CommandOptions } from 'commander';
import { IArgument, ICommand, IOption } from './interfaces.js';
export declare const META_COMMAND = "cli:command";
export declare const META_ARGUMENT = "cli:argument";
export declare const META_OPTION = "cli:options";
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
export declare function Command(nameAndArgs: string, description: string, opts?: CommandOptions): (target: object) => void;
export declare function Command(config: ICommand): (target: object) => void;
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
export declare function Option(flags: string, required?: boolean, description?: string, defaultValue?: any, parser?: (opt: string) => unknown): (target: object) => void;
export declare function Option(config: IOption): (target: object) => void;
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
export declare function Argument(name: string, required: boolean, description?: string, defaultValue?: any, parser?: (opt: string) => unknown): (target: object) => void;
export declare function Argument(config: IArgument): (target: object) => void;
//# sourceMappingURL=decorators.d.ts.map