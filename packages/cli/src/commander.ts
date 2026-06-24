/**
 * Re-export of the commander surface that this package exposes
 * (eg. the command handed to `CliCommand.onCreation`, or the error
 * types thrown during parsing). Consumers can import these from
 * `@spinajs/cli` without taking a direct dependency on commander.
 *
 * The `Command`, `Option` and `Argument` classes are aliased with a
 * `Commander` prefix because those names are already taken by this
 * package's `@Command` / `@Option` / `@Argument` decorators.
 */
export {
  Command as CommanderCommand,
  Option as CommanderOption,
  Argument as CommanderArgument,
  Help,
  CommanderError,
  InvalidArgumentError,
  createCommand,
  createOption,
  createArgument,
} from 'commander';

export type {
  CommandOptions,
  ExecutableCommandOptions,
  OptionValues,
  OptionValueSource,
  HookEvent,
  HelpConfiguration,
  OutputConfiguration,
  ParseOptions,
  AddHelpTextPosition,
} from 'commander';
