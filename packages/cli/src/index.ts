import { CliCommand, IArgument, ICommand, IOption } from './interfaces';
import { META_ARGUMENT, META_COMMAND, META_OPTION } from './decorators';
import { AsyncModule, DI } from '@spinajs/di';
import { Logger, ILog } from '@spinajs/log';
import { ResolveFromFiles, ClassInfo } from '@spinajs/reflection';
import { program } from 'commander';

export * from './interfaces';
export * from './decorators';

DI.register(() => {
  return process.argv;
}).as('__cli_argv_provider__');

export class Cli extends AsyncModule {
  @Logger('CLI')
  protected Log: ILog;

  @ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')
  public Commands: Promise<Array<ClassInfo<CliCommand>>>;

  public async resolveAsync(): Promise<void> {
    for (const command of await this.Commands) {
      this.Log.trace(`Found command ${command.name} in file ${command.file}`);

      const cMeta = Reflect.getMetadata(META_COMMAND, command.type as object) as ICommand;
      const oMeta = Reflect.getMetadata(META_OPTION, command.type as object) as IOption[];
      const aMeta = Reflect.getMetadata(META_ARGUMENT, command.type as object) as IArgument[];

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

      command.instance.onCreation(c);

      c.action(async (...args) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await command.instance.execute(...args);
      });
    }

    const argv = DI.resolve<string[]>('__cli_argv_provider__');

    program.parse(argv);
  }
}
