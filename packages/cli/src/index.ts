
import { CliCommand, IArgument, ICommand, IOption } from './interfaces.js';
import { META_ARGUMENT, META_COMMAND, META_OPTION } from './decorators.js';
import { AsyncService, ClassInfo, DI } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log-common';
import { program } from 'commander';
import { ResolveFromFiles } from '@spinajs/reflection';

export * from './interfaces.js';
export * from './decorators.js';



export class Cli extends AsyncService {
  @Logger('CLI')
  protected Log: Log;

  @ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')
  public Commands: Promise<Array<ClassInfo<CliCommand>>>;

  public async resolve(): Promise<void> {
    const commands = await this.Commands;
    if(!commands || commands.length === 0)
    {
      this.Log.warn('No registered commands found !');
      return;
    }

    for (const cmd of commands) {
      this.Log.trace(`Found command ${cmd.name}`);
      const cMeta = Reflect.getMetadata(META_COMMAND, cmd.instance as object) as ICommand;
      const oMeta = Reflect.getMetadata(META_OPTION, cmd.instance as object) as IOption[];
      const aMeta = Reflect.getMetadata(META_ARGUMENT, cmd.instance as object) as IArgument[];

      const c = program.command(cMeta.nameAndArgs, cMeta.description, cMeta.opts);

      oMeta.forEach((o) => {
        if (o.required) {
          c.requiredOption(o.flags, o.description, o.parser, o.defaultValue);
        } else {
          c.option(o.flags, o.description, o.parser, o.defaultValue);
        }
      });

      aMeta.forEach((a) => {
        c.argument(a.name, a.description, a.parser, a.defaultValue);
      });

      cmd.instance.onCreation(c);

      c.action(async (...args) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await cmd.instance.execute(...args);
      });
    }

    const argv = DI.resolve<string[]>('__cli_argv_provider__');

   
    program.parse(argv);
  }
}
