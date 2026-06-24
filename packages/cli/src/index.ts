import { CliCommand, IArgument, ICommand, IOption } from './interfaces.js';
import { META_ARGUMENT, META_COMMAND, META_OPTION } from './decorators.js';
import { AsyncService, ClassInfo, DI } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log-common';
import { Command } from 'commander';
import { ResolveFromFiles } from '@spinajs/reflection';
import { _check_arg, _non_nil } from '@spinajs/util';
import { createRequire } from 'module';

export * from './interfaces.js';
export * from './decorators.js';

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

  @ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')
  public Commands!: Promise<Array<ClassInfo<CliCommand>>>;

  public async resolve(): Promise<void> {

    await super.resolve();

    const commands = await this.Commands;
    if (!commands || commands.length === 0) {
      this.Log.warn('No registered commands found !');
      return;
    }

    const program = new Command();
    program.name('spinajs').description('SpinaJS command line interface').version(resolveCliVersion());

    for (const cmd of commands) {

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
      c.description(cMeta.description);

      // exitOverride is not inherited by subcommands added via addCommand,
      // so set it here too — otherwise per-command errors (eg. a missing
      // required option) would call process.exit and bypass our handling.
      c.exitOverride();

      oMeta?.forEach((o) => {
        const parser = (o.parser ?? ((value: string) => value)) as any;

        if (o.required) {
          // a required option can't meaningfully carry a default — the default
          // would satisfy the requirement and make it optional. drop it.
          if (o.defaultValue !== undefined) {
            this.Log.warn(`Option ${o.flags} is required; ignoring its default value`);
          }
          c.requiredOption(o.flags, o.description ?? '', parser);
        } else {
          c.option(o.flags, o.description ?? '', parser, o.defaultValue);
        }
      });

      aMeta?.forEach((a) => {
        // commander syntax: <name> = required, [name] = optional.
        // honor the @Argument required flag unless the name already
        // carries explicit brackets.
        const hasBrackets = /^[<[].*[>\]]$/.test(a.name);
        const name = hasBrackets ? a.name : a.required ? `<${a.name}>` : `[${a.name}]`;
        c.argument(name, a.description ?? '', (a.parser ?? ((value: string) => value)) as any, a.defaultValue);
      });

      cmd.instance!.onCreation(c);

      c.action(async (...args) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await cmd.instance!.execute(...args);
      });

      program.addCommand(c);
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
      // (output already written) → clean exit. anything else is a real error:
      // log it through the framework logger and propagate to the bin entry's
      // catch, which sets a non-zero exit code.
      if ((err as { exitCode?: number }).exitCode === 0) {
        return;
      }
      this.Log.error((err as { message?: string }).message ?? 'CLI error');
      throw err;
    }
  }
}
