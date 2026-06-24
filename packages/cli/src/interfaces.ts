import { AsyncService } from '@spinajs/di';
import { AddHelpTextPosition, Command, CommandOptions, HelpConfiguration } from 'commander';

export interface ICommand {
  nameAndArgs: string;
  description: string;
  opts?: CommandOptions;

  /**
   * Alternate names the command can be invoked by.
   */
  aliases?: string[];

  /**
   * Short summary shown in the parent command list (commander `summary`).
   */
  summary?: string;

  /**
   * Custom usage string shown in help.
   */
  usage?: string;

  /**
   * Name of the parent command to nest this command under. The parent
   * is matched by the first token of its `nameAndArgs`. When omitted the
   * command is registered at the top level.
   */
  parent?: string;

  /**
   * Allow options not declared on the command.
   */
  allowUnknownOption?: boolean;

  /**
   * Allow more positional arguments than declared.
   */
  allowExcessArguments?: boolean;

  /**
   * Treat options after the first operand as operands (commander `passThroughOptions`).
   */
  passThroughOptions?: boolean;

  /**
   * Enable positional options so subcommands can reuse option names (commander `enablePositionalOptions`).
   */
  enablePositionalOptions?: boolean;

  /**
   * Extra help sections appended/prepended to the generated help (commander `addHelpText`).
   */
  helpText?: Array<{ position: AddHelpTextPosition; text: string }>;

  /**
   * Customize help formatting (commander `configureHelp`).
   */
  configureHelp?: HelpConfiguration;
}

export interface IOption {
  flags: string;
  description?: string;
  defaultValue?: string | boolean | string[];
  required?: boolean;
  parser?: <T>(value: string, previous: T) => T;

  /**
   * Restrict the option value to one of the given choices.
   */
  choices?: string[];

  /**
   * Read the option value from the given environment variable when not
   * provided on the command line (commander `Option.env`).
   */
  env?: string;

  /**
   * Fall back to this `@spinajs/configuration` path when the option is not
   * provided on the command line. Used as the option default value.
   */
  configKey?: string;

  /**
   * Names of options this option cannot be combined with (commander `Option.conflicts`).
   */
  conflicts?: string | string[];

  /**
   * Other option values implied when this option is set (commander `Option.implies`).
   */
  implies?: Record<string, unknown>;

  /**
   * Preset value used when an optional-value option (`--x [val]`) is given without a value (commander `Option.preset`).
   */
  preset?: unknown;
}

export interface IArgument {
  name: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
  parser?: <T>(value: string, previous: T) => T;

  /**
   * Restrict the argument value to one of the given choices.
   */
  choices?: string[];

  /**
   * Collect multiple values into an array (commander variadic `name...`).
   */
  variadic?: boolean;
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

  /**
   * Commander `preAction` hook — runs before this command's action.
   *
   * @param thisCommand - the command the hook was registered on
   * @param actionCommand - the command whose action is about to run
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
  public onPreAction(_thisCommand: Command, _actionCommand: Command): void | Promise<void> {}

  /**
   * Commander `postAction` hook — runs after this command's action.
   *
   * @param thisCommand - the command the hook was registered on
   * @param actionCommand - the command whose action has run
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
  public onPostAction(_thisCommand: Command, _actionCommand: Command): void | Promise<void> {}
}
