import { CliCommand, IArgument, ICommand, IOption } from './interfaces.js';
import { META_ARGUMENT, META_COMMAND, META_OPTION } from './decorators.js';
import { AsyncService, Autoinject, ClassInfo, DI } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log-common';
import { Configuration } from '@spinajs/configuration';
import { Command, Option, Argument } from 'commander';
import { ResolveFromFiles } from '@spinajs/reflection';
import { createRequire } from 'module';

export * from './interfaces.js';
export * from './decorators.js';
export * from './commander.js';

/**
 * Best-effort lookup of this package version for `--version`.
 * Anchored at cwd so it works in both the cjs and mjs builds
 * (neither import.meta nor __dirname is available in both).
 */
function resolveCliVersion(): string {
  try {
    const require = createRequire(`${process.cwd()}/`);
    return (require('@spinajs/cli/package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}


export class Cli extends AsyncService {
  @Logger('CLI')
  protected Log!: Log;

  @Autoinject()
  protected Configuration!: Configuration;

  @ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')
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
    return typeof g.__ === 'function' ? g.__(text) : text;
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
    const built: Array<{ name: string; command: Command; parent?: string }> = [];

    for (const cmd of commands ?? []) {

      if(!cmd.instance){
        this.Log.warn(`Command ${cmd.name} is not resolved. Make sure it is decorated with @injectable and has a public constructor without required parameters`);
        continue;
      }

      this.Log.info(`Found command ${cmd.name}`);

      const cMeta = Reflect.getMetadata(META_COMMAND, cmd.type) as ICommand;
      const oMeta = Reflect.getMetadata(META_OPTION, cmd.type) as IOption[];
      const aMeta = Reflect.getMetadata(META_ARGUMENT, cmd.type) as IArgument[];

      if (!cMeta) {
        this.Log.warn(`Command ${cmd.name} is not marked as command. Use decorators to add description to command`);
        continue;
      }

      const c = new Command(cMeta.nameAndArgs);
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

        if (o.parser) opt.argParser(o.parser as (value: string, previous: unknown) => unknown);
        if (o.choices) opt.choices(o.choices);
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
            this.Log.warn(`Option ${o.flags} is required; ignoring its default value`);
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

        if (a.parser) arg.argParser(a.parser as (value: string, previous: unknown) => unknown);
        if (a.choices) arg.choices(a.choices);
        if (a.defaultValue !== undefined) arg.default(a.defaultValue);

        c.addArgument(arg);
      });

      cmd.instance!.onCreation(c);

      // lifecycle hooks — always registered, default to no-op on the base class.
      c.hook('preAction', (thisCommand, actionCommand) => cmd.instance!.onPreAction(thisCommand, actionCommand));
      c.hook('postAction', (thisCommand, actionCommand) => cmd.instance!.onPostAction(thisCommand, actionCommand));

      c.action(async (...args) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await cmd.instance!.execute(...args);
      });

      built.push({ name: cMeta.nameAndArgs.split(' ')[0], command: c, parent: cMeta.parent });
    }

    // second pass: assemble the command tree. children attach to their parent's
    // command object; everything else is registered at the top level.
    const byName = new Map(built.map((b) => [b.name, b.command]));
    for (const b of built) {
      if (b.parent) {
        const parent = byName.get(b.parent);
        if (parent) {
          parent.addCommand(b.command);
          continue;
        }
        this.Log.warn(`Parent command '${b.parent}' for '${b.name}' not found; registering at top level`);
      }
      program.addCommand(b.command);
    }

    program.exitOverride();
    program.showHelpAfterError();

    const argv = DI.resolve<string[]>('__cli_argv_provider__');

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
