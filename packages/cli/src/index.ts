import { CliCommand, IArgument, ICommand, IOption } from './interfaces.js';
import { META_ARGUMENT, META_COMMAND, META_OPTION } from './decorators.js';
import { CLI_ARGV_PROVIDER } from './tokens.js';
import { AsyncService, Autoinject, ClassInfo, DI } from '@spinajs/di';
import type { Log } from '@spinajs/log-common';
import { Configuration } from '@spinajs/configuration';
import { Command, Option, Argument, CommandOptions, InvalidArgumentError } from 'commander';
import { ListFromFiles } from '@spinajs/reflection';
import { createRequire } from 'module';
import { stripFrameworkOptions } from './argv.js';
import { resolveCliLog } from './cliLog.js';

export * from './interfaces.js';
export * from './decorators.js';
export * from './commander.js';
export * from './tokens.js';

/**
 * Best-effort lookup of this package version for `--version`.
 * Anchored at cwd so the version is the one the app installed.
 */
function resolveCliVersion(): string {
  try {
    const require = createRequire(`${process.cwd()}/`);
    return (require('@spinajs/cli/package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/**
 * commander's `choices()` replaces any parser set before it, so validate the
 * choice here and then run the parser.
 */
function parseWithChoices(choices: string[], parser: (value: string, previous: any) => unknown) {
  return (value: string, previous: unknown) => {
    if (!choices.includes(value)) {
      throw new InvalidArgumentError(`Allowed choices are ${choices.join(', ')}.`);
    }
    return parser(value, previous);
  };
}

export class Cli extends AsyncService {
  private log?: Log;

  /** Outside an application no command loads @spinajs/log, and `@Logger` would resolve the abstract class. */
  protected get Log(): Log {
    return (this.log ??= resolveCliLog());
  }

  @Autoinject()
  protected Configuration!: Configuration;

  /**
   * Commands are only LISTED here, never instantiated up front. Instantiation
   * is deferred until a command is actually invoked: constructing a command may
   * have heavy side effects ( eg. `@Autoinject() Orm` opening a database
   * connection ), and eager resolution would make every CLI run — including
   * ones that don't need those services, like cache generation during a docker
   * image build — fail when a dependency is unavailable.
   */
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')
  public Commands!: Promise<Array<ClassInfo<CliCommand>>>;

  /**
   * Soft, optional i18n of help text. `@spinajs/intl` installs a global `__`
   * translator when present and configured; when it isn't, this is a no-op so
   * the package carries no hard dependency on intl.
   */
  protected translate(text?: string): string {
    if (!text) {
      return text ?? '';
    }
    const g = globalThis as { __?: (t: string) => string };
    if (typeof g.__ !== 'function') {
      return text;
    }
    // `@spinajs/intl` installs the global at module import, but it throws until
    // the Intl service is actually resolved — treat that as "not configured".
    try {
      return g.__(text);
    } catch {
      return text;
    }
  }

  public async resolve(): Promise<void> {

    await super.resolve();

    const commands = await this.Commands;
    if (!commands || commands.length === 0) {
      // still build the program so --version / --help keep working.
      this.Log.warn('No registered commands found !');
    }

    // route commander's error output (and after-error help) through the
    // framework logger; normal help/version still go to stdout via writeOut.
    const writeErr = (str: string) => {
      const msg = str.trim();
      if (msg) {
        this.Log.error(msg);
      }
    };

    const program = new Command();
    program.name('spinajs').description('SpinaJS command line interface').version(resolveCliVersion());
    program.configureOutput({ writeErr });
    program.showSuggestionAfterError(true);

    // first pass: build each command in isolation, remembering its parent (if any)
    // so the command tree can be assembled afterwards regardless of iteration order.
    const built: Array<{ name: string; command: Command; parent?: string; opts?: CommandOptions }> = [];

    // lazy, memoized command instances — resolved at most once, and only when
    // the command ( or a parent on its dispatch path ) is actually invoked.
    const lazyInstances = new Map<Command, () => Promise<CliCommand>>();

    for (const cmd of commands ?? []) {

      if (typeof cmd.type !== 'function') {
        this.Log.warn({ command: cmd.name }, 'Command ${command} has no exported class. Make sure the file exports a CliCommand subclass');
        continue;
      }

      const cMeta = Reflect.getMetadata(META_COMMAND, cmd.type) as ICommand;

      if (!cMeta) {
        // every export of a command file is listed, helpers next to the command included
        if (cmd.type.prototype instanceof CliCommand) {
          this.Log.warn({ command: cmd.name }, 'Command ${command} is not marked as command. Use decorators to add description to command');
        }
        continue;
      }

      this.Log.info({ command: cmd.name }, 'Found command ${command}');

      const oMeta = Reflect.getMetadata(META_OPTION, cmd.type) as IOption[];
      const aMeta = Reflect.getMetadata(META_ARGUMENT, cmd.type) as IArgument[];

      const [, name, args] = /([^ ]+) *(.*)/.exec(cMeta.nameAndArgs) ?? [];
      const c = new Command(name);
      if (args) c.arguments(args);
      c.description(this.translate(cMeta.description));

      // exitOverride / output config / suggestions are not inherited by
      // subcommands added via addCommand, so set them here too — otherwise
      // per-command errors (eg. a missing required option) would call
      // process.exit and bypass our handling.
      c.exitOverride();
      c.configureOutput({ writeErr });
      c.showSuggestionAfterError(true);

      if (cMeta.summary) c.summary(this.translate(cMeta.summary));
      if (cMeta.usage) c.usage(cMeta.usage);
      if (cMeta.aliases?.length) c.aliases(cMeta.aliases);
      if (cMeta.allowUnknownOption) c.allowUnknownOption(true);
      if (cMeta.allowExcessArguments !== undefined) c.allowExcessArguments(cMeta.allowExcessArguments);
      if (cMeta.passThroughOptions) c.passThroughOptions(true);
      if (cMeta.enablePositionalOptions) c.enablePositionalOptions(true);
      if (cMeta.configureHelp) c.configureHelp(cMeta.configureHelp);
      cMeta.helpText?.forEach((h) => c.addHelpText(h.position, this.translate(h.text)));

      oMeta?.forEach((o) => {
        const opt = new Option(o.flags, this.translate(o.description));

        if (o.choices) opt.choices(o.choices);
        if (o.parser) {
          const parser = o.choices ? parseWithChoices(o.choices, o.parser) : o.parser;
          opt.argParser(parser as (value: string, previous: unknown) => unknown);
        }
        if (o.env) opt.env(o.env);
        if (o.conflicts) opt.conflicts(o.conflicts);
        if (o.implies) opt.implies(o.implies);
        if (o.preset !== undefined) opt.preset(o.preset);

        // an explicit default wins; otherwise fall back to a configuration value.
        const cfgDefault = o.configKey !== undefined ? this.Configuration.get<unknown>(o.configKey) : undefined;
        const defaultValue = o.defaultValue !== undefined ? o.defaultValue : cfgDefault;

        if (o.required) {
          opt.makeOptionMandatory(true);
          // a required option can't meaningfully carry a default — the default
          // would satisfy the requirement and make it optional. drop it.
          if (defaultValue !== undefined) {
            this.Log.warn({ flags: o.flags }, 'Option ${flags} is required; ignoring its default value');
          }
        } else if (defaultValue !== undefined) {
          opt.default(defaultValue);
        }

        c.addOption(opt);
      });

      aMeta?.forEach((a) => {
        // commander syntax: <name> = required, [name] = optional, trailing ... = variadic.
        // honor the @Argument required/variadic flags unless the name already
        // carries explicit brackets.
        let name: string;
        if (/^[<[].*[>\]]$/.test(a.name)) {
          name = a.name;
        } else {
          const inner = a.variadic ? `${a.name}...` : a.name;
          name = a.required ? `<${inner}>` : `[${inner}]`;
        }

        const arg = new Argument(name, this.translate(a.description));

        if (a.choices) arg.choices(a.choices);
        if (a.parser) {
          const parser = a.choices ? parseWithChoices(a.choices, a.parser) : a.parser;
          arg.argParser(parser as (value: string, previous: unknown) => unknown);
        }
        if (a.defaultValue !== undefined) arg.default(a.defaultValue);

        c.addArgument(arg);
      });

      let instance: Promise<CliCommand> | null = null;
      const getInstance = () => {
        if (!instance) {
          instance = Promise.resolve(DI.resolve(cmd.type) as CliCommand | Promise<CliCommand>).catch((err: Error) => {
            this.Log.error({ error: err, command: cmd.name, file: cmd.file }, 'Cannot resolve command ${command} ( ${file} )');
            throw err;
          });
        }
        return instance;
      };
      lazyInstances.set(c, getInstance);

      // lifecycle hooks — always registered, default to no-op on the base class.
      // the instance is resolved lazily; for the invoked command `onCreation`
      // already resolved it in the parent's preSubcommand hook, so these await
      // the memoized promise instead of resolving again.
      c.hook('preAction', async (thisCommand, actionCommand) => (await getInstance()).onPreAction(thisCommand, actionCommand));
      c.hook('postAction', async (thisCommand, actionCommand) => (await getInstance()).onPostAction(thisCommand, actionCommand));

      c.action(async (...args) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await (await getInstance()).execute(...args);
      });

      built.push({ name, command: c, parent: cMeta.parent, opts: cMeta.opts });
    }

    // second pass: assemble the command tree. children attach to their parent's
    // command object; everything else is registered at the top level.
    const byName = new Map(built.map((b) => [b.name, b.command]));
    for (const b of built) {
      if (b.parent) {
        const parent = byName.get(b.parent);
        if (parent) {
          parent.addCommand(b.command, b.opts);
          continue;
        }
        this.Log.warn({ parent: b.parent, command: b.name }, 'Parent command ${parent} for ${command} not found; registering at top level');
      }
      program.addCommand(b.command, b.opts);
    }

    // `onCreation` may customize a command ( extra options, help text ) and so
    // must run before that command parses its arguments. commander's
    // preSubcommand hook fires after the subcommand is selected but before it
    // parses — resolve the instance there, only for commands on the actual
    // dispatch path. This is what keeps unrelated commands un-instantiated.
    const lazyOnCreation = (parent: Command) => {
      parent.hook('preSubcommand', async (_thisCommand, subcommand) => {
        const get = lazyInstances.get(subcommand);
        if (get) {
          await (await get()).onCreation(subcommand);
        }
      });
    };
    lazyOnCreation(program);
    built.forEach((b) => lazyOnCreation(b.command));

    program.exitOverride();
    program.showHelpAfterError();

    // the provider is registered by the bin ( args.ts ), not by the package entry
    const argv = DI.resolve(CLI_ARGV_PROVIDER) ?? stripFrameworkOptions(process.argv);

    // nothing but `node script` → show help rather than silently doing nothing
    if (argv.slice(2).length === 0) {
      program.outputHelp();
      return;
    }

    try {
      await program.parseAsync(argv);
    } catch (err) {
      // commander throws under exitOverride. --help / --version use exitCode 0
      // (output already written) → clean exit. anything else is a real error;
      // commander already routed its message through configureOutput → the
      // framework logger, so just propagate to the bin entry's catch, which
      // sets a non-zero exit code.
      if ((err as { exitCode?: number }).exitCode === 0) {
        return;
      }
      throw err;
    }
  }
}
